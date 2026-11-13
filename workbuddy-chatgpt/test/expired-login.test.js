import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedirectOAuth } from '../oauth-redirect.js';
import { createAccountAuth } from '../auth-account.js';
import { createOfficialApi } from '../official-api.js';

test('invalid refresh grant requires login and keeps encrypted record available for replacement', async () => {
  const record = { kind: 'grant', payload: { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', clientId: 'fixture-client', expires: 1, scopes: ['chatgpt.tokens.use.direct'] } };
  let requests = 0;
  const oauth = createRedirectOAuth({ fetchImpl: async () => { requests++; return Response.json({ error: 'invalid_grant', secret: 'DO_NOT_EXPOSE' }, { status: 400 }); } });
  const auth = createAccountAuth({ credentials: { readRecord: async () => record, modifyRecord: async (key, change) => { const next = await change(record); return next ?? record; } } }, { oauth });
  const api = createOfficialApi({ auth });
  await assert.rejects(api.models(), error => error.status === 401 && error.code === 'AUTH_GRANT_INVALID' && error.message.includes('重新登录') && !error.message.includes('DO_NOT_EXPOSE'));
  const status = await auth.status();
  assert.equal(status.configured, false);
  assert.equal(status.error.code, 'AUTH_GRANT_INVALID');
  await assert.rejects(api.models(), { code: 'AUTH_GRANT_INVALID' });
  assert.equal(requests, 1);
  assert.equal(record.payload.refresh, 'fixture-refresh');
  await auth.close();
});

test('refresh network failure retains retryable status and is not reported as authentication failure', async () => {
  const auth = createAccountAuth({ credentials: {
    readRecord: async () => ({ kind: 'grant', payload: { type: 'oauth', access: 'fixture', refresh: 'fixture', clientId: 'fixture', expires: 1, scopes: ['chatgpt.tokens.use.direct'] } }),
    modifyRecord: async (key, change) => change({ kind: 'grant', payload: { type: 'oauth', access: 'fixture', refresh: 'fixture', clientId: 'fixture', expires: 1, scopes: ['chatgpt.tokens.use.direct'] } }),
  } }, { oauth: { login() {}, refresh: async () => { throw Object.assign(new Error('private'), { code: 'OPENAI_NETWORK_TIMEOUT' }); } } });
  await assert.rejects(createOfficialApi({ auth }).models(), { status: 502, code: 'OPENAI_NETWORK_TIMEOUT' });
  assert.equal((await auth.status()).configured, true);
  await auth.close();
});
