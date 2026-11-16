import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRedirectOAuth } from '../oauth-redirect.js';
import { createOfficialApi } from '../official-api.js';
import { createQuotaReader } from '../quota.js';

test('plugin-owned subscription login returns its own grant and refreshes on standard token endpoint', async () => {
  let notice;
  const ready = new Promise(resolve => { notice = resolve; });
  const calls = [];
  const oauth = createRedirectOAuth({ subscription: true, callbackPort: 0, fetchImpl: async (url, options) => {
    const body = new URLSearchParams(options.body);
    assert.equal(url, 'https://auth.openai.com/oauth/token');
    assert.equal(body.has('resource'), false);
    calls.push(body.get('grant_type'));
    return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', id_token: 'fixture-id', expires_in: 3600, scope: 'openid profile email offline_access' });
  } });
  const controller = new AbortController();
  const login = oauth.login({ signal: controller.signal, notify: event => { if (event.type === 'auth_url') notice(new URL(event.url)); } }, { getDeviceId: randomUUID });
  try {
    const url = await ready;
    assert.equal(url.pathname, '/oauth/authorize');
    assert.equal(url.searchParams.has('resource'), false);
    assert.equal(url.searchParams.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
    const callback = new URL(url.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', url.searchParams.get('state'));
    callback.searchParams.set('code', 'fixture-code');
    assert.equal((await fetch(callback, { redirect: 'manual' })).status, 303);
    const grant = await login;
    assert.equal(grant.authMode, 'subscription');
    assert.equal((await oauth.refresh(grant)).authMode, 'subscription');
    assert.deepEqual(calls, ['authorization_code', 'refresh_token']);
  } finally { controller.abort(); await login.catch(() => {}); }
});

test('models inference and quota all use the same plugin account bearer', async () => {
  const requests = [];
  const auth = { accessToken: async () => 'plugin-account', accountContext: async () => ({ mode: 'subscription', accountId: 'account' }) };
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer plugin-account');
    assert.equal(options.headers['chatgpt-account-id'], 'account');
    requests.push(url);
    if (url.includes('/models?')) return Response.json({ models: [{ slug: 'fixture', visibility: 'list' }] });
    if (url.endsWith('/usage')) return Response.json({ rate_limit: { primary_window: { used_percent: 20 } } });
    return new Response('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  const quota = createQuotaReader({ auth, fetchImpl });
  const api = createOfficialApi({ auth, fetchImpl, quotaProvider: signal => quota.read(signal) });
  assert.equal((await api.models()).models[0].id, 'fixture');
  for await (const event of api.streamResponses({ model: 'fixture', input: [] })) void event;
  assert.equal((await api.usage()).windows[0].remainingPercent, 80);
  assert.deepEqual(requests, ['https://chatgpt.com/backend-api/codex/models?client_version=0.169.0-alpha.11.1', 'https://chatgpt.com/backend-api/codex/responses', 'https://chatgpt.com/backend-api/wham/usage']);
});
