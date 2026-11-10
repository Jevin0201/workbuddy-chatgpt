import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as rawRequest } from 'node:http';
import { createRedirectOAuth } from '../oauth-redirect.js';
import { createAccountAuth } from '../auth-account.js';
import { createServerBridge } from '../server.js';
const token = 'fixture-local-key-012345678901234567890123456789';
async function fixture(t, fetchImpl) {
  const records = new Map();
  const credentials = { readRecord: async key => records.get(key), modifyRecord: async (key, change) => { const next = await change(records.get(key)); if (next !== undefined) records.set(key, next); return records.get(key); } };
  let auth;
  const proxy = Object.fromEntries(['status', 'start', 'cancel', 'authorizationUrl', 'answer', 'close'].map(key => [key, (...args) => auth[key](...args)]));
  const api = { models: async () => ({ models: [], source: 'account' }), usage: async () => ({ available: false }) };
  const bridge = createServerBridge({ ctx: {}, auth: proxy, api, engine: {}, token, port: 0 });
  bridge.server.listen(0, '127.0.0.1'); await once(bridge.server, 'listening');
  const base = `http://127.0.0.1:${bridge.server.address().port}`;
  const oauth = createRedirectOAuth({ refresh: async () => {}, returnUrl: base + '/?auth_return=1', callbackPort: 0, fetchImpl });
  auth = createAccountAuth({ credentials }, { oauth });
  t.after(() => bridge.close());
  return { base, auth, records };
}
function tokenReply() { return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', id_token: 'fixture-id-token', expires_in: 3600, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' }); }
async function start(base, path = '/?from=workbuddy&autostart=1') {
  const response = await fetch(base + path, { redirect: 'manual' });
  assert.equal(response.status, 303);
  const authorization = new URL(response.headers.get('location'));
  assert.equal(authorization.origin, 'https://auth.openai.com'); assert.equal(authorization.pathname, '/api/accounts/authorize');
  const callback = new URL(authorization.searchParams.get('redirect_uri'));
  callback.searchParams.set('state', authorization.searchParams.get('state'));
  return { response, authorization, callback };
}
test('native WorkBuddy entry redirects directly to official OAuth and callback returns in the same tab', async t => {
  let submitted;
  const { base, auth, records } = await fixture(t, async (url, options) => { assert.equal(url, 'https://auth.openai.com/api/accounts/oauth/token'); assert.equal(options.redirect, 'error'); submitted = new URLSearchParams(options.body); return tokenReply(); });
  const { response, authorization, callback } = await start(base);
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal(authorization.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  callback.searchParams.set('code', 'fixture-code'); callback.searchParams.set('client_id', 'app_issued_fixture');
  const returned = await fetch(callback, { redirect: 'manual' });
  assert.equal(returned.status, 303); assert.equal(returned.headers.get('location'), base + '/?auth_return=1');
  assert.equal(submitted.get('code'), 'fixture-code'); assert.equal(submitted.get('resource'), 'https://api.openai.com/v1');
  const status = await auth.status(); assert.equal(status.configured, true); assert.equal(status.state, 'authorized');
  assert.equal(records.get('workbuddy-openai/account').payload.clientId, 'app_issued_fixture');
  const page = await fetch(returned.headers.get('location'), { redirect: 'manual' }); assert.equal(page.status, 200);
  const html = await page.text(); assert.match(html, /显示的模型/); assert.doesNotMatch(html, /fixture-access|fixture-refresh|fixture-code/);
  assert.equal((await fetch(base + '/?from=workbuddy&autostart=1', { redirect: 'manual' })).status, 200);
});
test('repeated native entry reuses one active authorization instead of creating a state mismatch', async t => {
  const { base, auth } = await fixture(t, async () => tokenReply());
  const first = await start(base), second = await start(base);
  assert.equal(first.authorization.href, second.authorization.href);
  await auth.cancel(); assert.equal((await auth.status()).state, 'cancelled');
});
test('invalid-state denial cannot cancel another login; validated denial returns without a redirect loop', async t => {
  let fetches = 0; const { base, auth } = await fixture(t, async () => { fetches++; return tokenReply(); });
  const { callback } = await start(base); const bad = new URL(callback); bad.searchParams.set('state', 'invalid'); bad.searchParams.set('error', 'access_denied');
  assert.equal((await fetch(bad, { redirect: 'manual' })).status, 400); assert.equal((await auth.status()).state, 'running');
  bad.searchParams.set('state', '😀'.repeat(21) + 'a');
  assert.equal((await fetch(bad, { redirect: 'manual' })).status, 400); assert.equal((await auth.status()).state, 'running');
  callback.searchParams.set('error', 'access_denied'); const denied = await fetch(callback, { redirect: 'manual' });
  assert.equal(denied.status, 303); assert.equal(denied.headers.get('location'), base + '/?auth_return=1');
  assert.equal((await auth.status()).state, 'failed'); assert.equal(fetches, 0);
  assert.equal((await fetch(denied.headers.get('location'), { redirect: 'manual' })).status, 200);
});
test('malformed callback request targets fail without cancelling the active login', async t => {
  const { base, auth } = await fixture(t, async () => tokenReply());
  const { callback } = await start(base);
  const status = await new Promise((resolve, reject) => {
    const request = rawRequest({ hostname: callback.hostname, port: callback.port, method: 'GET', path: 'http://[', headers: { Host: callback.host } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(status, 400); assert.equal((await auth.status()).state, 'running'); await auth.cancel();
});

test('token exchange failure returns to model page without exposing errors or credentials', async t => {
  const { base, auth } = await fixture(t, async () => new Response('sensitive-upstream-diagnostic', { status: 400 }));
  const { callback } = await start(base); callback.searchParams.set('code', 'fixture-code'); callback.searchParams.set('client_id', 'app_fixture');
  const returned = await fetch(callback, { redirect: 'manual' }); assert.equal(returned.status, 303); assert.equal(returned.headers.get('location'), base + '/?auth_return=1');
  const status = await auth.status(); assert.equal(status.configured, false); assert.equal(status.state, 'failed'); assert.doesNotMatch(JSON.stringify(status), /sensitive-upstream|fixture-code/);
});
test('direct login route rejects foreign origins, subresource launch and unsafe return URLs', async t => {
  const { base } = await fixture(t, async () => tokenReply());
  assert.equal((await fetch(base + '/login', { headers: { Origin: 'https://foreign.invalid' }, redirect: 'manual' })).status, 403);
  assert.equal((await fetch(base + '/login', { headers: { 'Sec-Fetch-Dest': 'image' }, redirect: 'manual' })).status, 403);
  assert.throws(() => createRedirectOAuth({ refresh() {}, returnUrl: 'https://foreign.invalid/' }), /destination/);
  assert.throws(() => createRedirectOAuth({ refresh() {}, returnUrl: 'http://127.0.0.1:51380/?return_url=https://foreign.invalid' }), /destination/);
});

test('refresh uses supplied transport, rotates grant and preserves dynamic client and unknown fields', async () => {
  const credential = { type: 'oauth', access: 'old-access', refresh: 'old-refresh', clientId: 'app_dynamic', scopes: ['openid', 'chatgpt.tokens.use.direct'], expires: 0, extra: { retained: true } };
  let calls = 0;
  const oauth = createRedirectOAuth({ refresh() { assert.fail('legacy refresh must stay unused'); }, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://auth.openai.com/api/accounts/oauth/token');
    assert.equal(options.redirect, 'error'); assert.equal(options.method, 'POST');
    assert.deepEqual(Object.fromEntries(options.body), { grant_type: 'refresh_token', client_id: 'app_dynamic', refresh_token: 'old-refresh', resource: 'https://api.openai.com/v1' });
    return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
  } });
  const before = Date.now();
  const next = await oauth.refresh(credential, new AbortController().signal);
  assert.equal(calls, 1); assert.equal(next.access, 'new-access'); assert.equal(next.refresh, 'new-refresh');
  assert.equal(next.clientId, credential.clientId); assert.deepEqual(next.scopes, credential.scopes); assert.deepEqual(next.extra, credential.extra);
  assert.ok(next.expires >= before + 3420000 && next.expires <= Date.now() + 3420000);
  assert.equal(credential.refresh, 'old-refresh'); assert.equal('id_token' in next, false);
});

test('callback failures return to bridge with safe stage diagnostics and allow a fresh attempt', async t => {
  const cases = [
    [() => new Response('SECRET_UPSTREAM', { status: 401 }), 'AUTH_TOKEN_HTTP_401'],
    [() => { throw Object.assign(new Error('SECRET_URL_TOKEN'), { code: 'OPENAI_NETWORK_TIMEOUT' }); }, 'OPENAI_NETWORK_TIMEOUT'],
    [() => { throw Object.assign(new Error('SECRET_URL_TOKEN'), { code: 'transport_upstream_error' }); }, 'transport_upstream_error'],
    [() => Response.json({ access_token: 'SECRET_ACCESS' }), 'AUTH_GRANT_SCHEMA'],
    [() => new Response('{SECRET_INVALID_JSON'), 'AUTH_GRANT_SCHEMA'],
    [() => new Response('x'.repeat(1024 * 1024 + 1)), 'AUTH_GRANT_SCHEMA'],
    [() => Response.json({ access_token: 'a', refresh_token: 'r', id_token: 'i', expires_in: 3600, scope: 'openid' }), 'AUTH_SCOPE_MISSING'],
  ];
  for (const [response, expected] of cases) await t.test(expected, async t => {
    let fail = true;
    const { base, auth } = await fixture(t, async () => fail ? response() : tokenReply());
    const { callback } = await start(base); callback.searchParams.set('code', 'SECRET_CODE'); callback.searchParams.set('client_id', 'app_fixture');
    const returned = await fetch(callback, { redirect: 'manual' });
    assert.equal(returned.status, 303); assert.equal(returned.headers.get('location'), base + '/?auth_return=1');
    const status = await auth.status(); assert.equal(status.error.code, expected); assert.equal(status.configured, false);
    assert.doesNotMatch(JSON.stringify(status), /SECRET/);
    fail = false;
    const retry = await start(base); retry.callback.searchParams.set('code', 'retry'); retry.callback.searchParams.set('client_id', 'app_fixture');
    await fetch(retry.callback, { redirect: 'manual' }); assert.equal((await auth.status()).configured, true);
  });
});

test('refresh validates schema, positive expiry and scope without exposing upstream data', async () => {
  const credential = { clientId: 'app_fixture', refresh: 'old', scopes: ['chatgpt.tokens.use.direct'] };
  for (const [body, code] of [
    [{ access_token: 'a', refresh_token: 'r', expires_in: 0 }, 'AUTH_GRANT_SCHEMA'],
    [{ access_token: 'a', expires_in: 3600 }, 'AUTH_GRANT_SCHEMA'],
    [{ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'openid' }, 'AUTH_SCOPE_MISSING'],
  ]) {
    const oauth = createRedirectOAuth({ fetchImpl: async () => Response.json(body) });
    await assert.rejects(oauth.refresh(credential), { code });
  }
  const network = Object.assign(new Error('SECRET'), { code: 'OPENAI_NETWORK_FAILED' });
  const oauth = createRedirectOAuth({ fetchImpl: async () => { throw network; } });
  await assert.rejects(oauth.refresh(credential), error => error === network);
});
