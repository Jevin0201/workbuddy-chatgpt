import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { getEventListeners } from 'node:events';
import { createAccountAuth } from '../auth-account.js';

const ACCOUNT = 'workbuddy-openai/account';
const INSTALLATION = 'workbuddy-openai/installation';
const valid = extra => ({ type: 'oauth', access: 'ACCESS_SECRET', refresh: 'REFRESH_SECRET',
  expires: 20000, clientId: 'CLIENT_SECRET', scopes: ['chatgpt.tokens.use.direct'], ...extra });
function store(initial = {}) {
  const records = new Map(Object.entries(initial));
  const operations = [];
  let queue = Promise.resolve();
  return {
    records, operations,
    async readRecord(key) { operations.push(['read', key]); return structuredClone(records.get(key)); },
    modifyRecord(key, mutate) {
      operations.push(['modify', key]);
      const result = queue.then(async () => {
        const current = structuredClone(records.get(key));
        const next = await mutate(current);
        if (next !== undefined) records.set(key, structuredClone(next));
        return structuredClone(records.get(key));
      });
      queue = result.catch(() => {});
      return result;
    },
  };
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    const result = await predicate();
    if (result) return result;
    await tick();
  }
  throw new Error('Condition did not settle');
}
const settled = auth => until(async () => { const s = await auth.status(); return s.state !== 'running' && s; });
const hasStatus = status => error => error.status === status;

test('login persists scoped grant and stable installation UUID without leaking credentials', async () => {
  const credentials = store();
  const devices = [];
  let calls = 0;
  const auth = createAccountAuth({ credentials }, { now: () => 1000, oauth: {
    async login(interaction, options) {
      calls++;
      devices.push(options.getDeviceId());
      assert.equal(options.agentName, 'WorkBuddy OpenAI Bridge');
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/api/accounts/authorize?state=EXAMPLE' });
      const answer = await interaction.prompt({ type: 'manual_code', message: 'Paste callback', placeholder: 'http://127.0.0.1:1455/auth/callback' });
      assert.equal(answer, 'callback');
      return valid();
    }, async refresh() { throw new Error('Unexpected refresh'); },
  } });
  for (let i = 0; i < 2; i++) {
    await auth.start();
    const s = await until(async () => { const s = await auth.status(); return s.prompt && s; });
    assert.equal(s.state, 'running');
    assert.equal(s.notices[0].type, 'auth_url');
    assert.equal(s.prompt.kind, 'manual_code');
    await auth.answer({ id: s.prompt.id, value: 'callback' });
    const final = await settled(auth);
    assert.equal(final.state, 'authorized');
    assert.equal(final.configured, true);
    assert.deepEqual(final.notices, []);
    assert.equal(final.prompt, null);
    for (const secret of ['ACCESS_SECRET', 'REFRESH_SECRET', 'CLIENT_SECRET']) assert.equal(JSON.stringify(final).includes(secret), false);
  }
  assert.equal(calls, 2);
  assert.equal(devices[0], devices[1]);
  assert.match(devices[0], /^[0-9a-f-]{36}$/);
  assert.equal(credentials.records.get(INSTALLATION).payload.deviceId, devices[0]);
  assert.equal(await auth.accessToken(), 'ACCESS_SECRET');
  assert.ok(credentials.operations.every(([, key]) => [ACCOUNT, INSTALLATION].includes(key)));
  await auth.close();
});

test('ten-minute deadline aborts even an uncooperative login and clears public interaction', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const credentials = store();
  let entered = false;
  const auth = createAccountAuth({ credentials }, { oauth: {
    async login(interaction) {
      entered = true;
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/api/accounts/authorize' });
      return new Promise(() => {});
    }, async refresh() {},
  } });
  await auth.start();
  await until(() => entered);
  t.mock.timers.tick(10 * 60 * 1000);
  const s = await settled(auth);
  assert.equal(s.state, 'failed');
  assert.equal(s.error.code, 'AUTH_TIMEOUT');
  assert.deepEqual(s.notices, []);
  assert.equal(s.prompt, null);
  await auth.close();
});

test('cross-instance refresh lock rechecks expiry and saves rotating refresh once', async () => {
  const credentials = store({ [ACCOUNT]: { kind: 'grant', label: 'preserved', payload: valid({ expires: 0, extra: 'preserved' }) } });
  let count = 0;
  const oauth = { async login() { throw new Error('Unexpected login'); }, async refresh(credential) {
    count++;
    assert.equal(credential.refresh, 'REFRESH_SECRET');
    await tick();
    return valid({ access: 'ROTATED_ACCESS', refresh: 'ROTATED_REFRESH', expires: 40000 });
  } };
  const a = createAccountAuth({ credentials }, { oauth, now: () => 1000 });
  const b = createAccountAuth({ credentials }, { oauth, now: () => 1000 });
  assert.deepEqual(await Promise.all([a.accessToken(), b.accessToken(), a.accessToken()]), ['ROTATED_ACCESS', 'ROTATED_ACCESS', 'ROTATED_ACCESS']);
  assert.equal(count, 1);
  assert.equal(credentials.records.get(ACCOUNT).payload.refresh, 'ROTATED_REFRESH');
  assert.equal(credentials.records.get(ACCOUNT).payload.extra, 'preserved');
  assert.equal(credentials.records.get(ACCOUNT).label, 'preserved');
  await a.close(); await b.close();
});

test('cancel withdraws pending prompt; stale answers and overlapping starts reject 409', async () => {
  const credentials = store();
  let calls = 0;
  const auth = createAccountAuth({ credentials }, { oauth: {
    async login(interaction) {
      calls++;
      await interaction.prompt({ type: 'secret', message: 'Value' });
      return valid();
    }, async refresh() {},
  } });
  await auth.start();
  const p = await until(async () => (await auth.status()).prompt);
  await assert.rejects(auth.start(), hasStatus(409));
  await assert.rejects(auth.answer({ id: 'wrong', value: 'x' }), hasStatus(409));
  await auth.cancel();
  const s = await auth.status();
  assert.equal(s.state, 'cancelled');
  assert.equal(s.prompt, null);
  assert.deepEqual(s.notices, []);
  assert.equal(s.configured, false);
  await assert.rejects(auth.answer({ id: p.id, value: 'x' }), hasStatus(409));
  assert.equal(calls, 1);
  await auth.close();
});

test('provider abort signal withdraws manual prompt after browser wins race', async () => {
  let browserWins;
  const browser = new Promise(resolve => { browserWins = resolve; });
  const credentials = store();
  const auth = createAccountAuth({ credentials }, { oauth: {
    async login(interaction) {
      const controller = new AbortController();
      const manual = interaction.prompt({ type: 'manual_code', message: 'Callback', signal: controller.signal });
      try { await Promise.race([manual, browser]); return valid(); }
      finally { controller.abort(); }
    }, async refresh() {},
  } });
  await auth.start();
  const p = await until(async () => (await auth.status()).prompt);
  browserWins();
  assert.equal((await settled(auth)).prompt, null);
  await assert.rejects(auth.answer({ id: p.id, value: 'callback' }), hasStatus(409));
  await auth.close();
});

test('cancel before late prompt prevents late account write even if provider ignores abort', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const credentials = store();
  let entered = false;
  const auth = createAccountAuth({ credentials }, { oauth: {
    async login(interaction) {
      entered = true;
      await gate;
      await assert.rejects(interaction.prompt({ type: 'secret', message: 'late' }));
      return valid();
    }, async refresh() {},
  } });
  await auth.start();
  await until(() => entered);
  await auth.cancel();
  release();
  await tick();
  assert.equal((await auth.status()).prompt, null);
  assert.equal(credentials.records.has(ACCOUNT), false);
  await auth.close();
});

test('missing direct scope rejects login and stored grant; never falls back to Codex', async () => {
  const credentials = store();
  const auth = createAccountAuth({ credentials }, { oauth: {
    async login() { return valid({ scopes: ['openid'] }); }, async refresh() { throw new Error('Unexpected refresh'); },
  } });
  await auth.start();
  assert.equal((await settled(auth)).state, 'failed');
  assert.equal(credentials.records.has(ACCOUNT), false);
  credentials.records.set(ACCOUNT, { kind: 'grant', payload: valid({ scopes: ['openid'] }) });
  assert.equal((await auth.status()).configured, false);
  await assert.rejects(auth.accessToken(), hasStatus(401));
  assert.ok(credentials.operations.every(([, key]) => [ACCOUNT, INSTALLATION].includes(key)));
  await auth.close();
});

test('installation persists across factories and failed account switch retains previous grant', async () => {
  const deviceId = 'd2916683-9b27-4bfd-ac88-69f04bda58c2';
  const previous = { kind: 'grant', payload: valid() };
  const credentials = store({ [ACCOUNT]: previous, [INSTALLATION]: { kind: 'grant', payload: { deviceId } } });
  let observed;
  const oauth = { async login(interaction, options) {
    observed = options.getDeviceId();
    throw new Error('provider access_token=ACCESS_SECRET email=PROFILE_SECRET');
  }, async refresh() {} };
  const first = createAccountAuth({ credentials }, { oauth });
  await first.close();
  const second = createAccountAuth({ credentials }, { oauth });
  await second.start();
  const s = await settled(second);
  assert.equal(observed, deviceId);
  assert.equal(s.state, 'failed');
  assert.equal(s.configured, true);
  assert.equal(JSON.stringify(s).includes('SECRET'), false);
  assert.deepEqual(credentials.records.get(ACCOUNT), previous);
  await second.close();
});

test('bad refresh preserves existing record and sanitized error excludes provider response', async () => {
  const previous = { kind: 'grant', payload: valid({ expires: 0 }) };
  const credentials = store({ [ACCOUNT]: previous });
  const auth = createAccountAuth({ credentials }, { now: () => 1000, oauth: {
    async login() {}, async refresh() { return valid({ scopes: ['openid'] }); },
  } });
  await assert.rejects(auth.accessToken(), error => error.status === 401 && !error.message.includes('REFRESH_SECRET'));
  assert.deepEqual(credentials.records.get(ACCOUNT), previous);
  await auth.close();
});

test('busy callback port gets actionable Chinese error while raw error and notices are cleared', async () => {
  const credentials = store();
  const auth = createAccountAuth({ credentials }, { oauth: {
    async login(interaction) {
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/api/accounts/authorize?state=example' });
      throw new Error('Port 1455 is in use, SECRET_PROVIDER_ERROR CLIENT_SECRET');
    }, async refresh() {},
  } });
  await auth.start();
  const s = await settled(auth);
  assert.equal(s.error.code, 'CALLBACK_PORT_BUSY');
  assert.match(s.error.message, /1455/);
  assert.equal(JSON.stringify(s).includes('SECRET'), false);
  assert.deepEqual(s.notices, []);
  await auth.close();
});

test('select validates option IDs; already configured status never auto-starts login', async () => {
  const credentials = store({ [ACCOUNT]: { kind: 'grant', payload: valid() } });
  let calls = 0;
  const auth = createAccountAuth({ credentials }, { oauth: {
    async login(interaction) {
      calls++;
      assert.equal(await interaction.prompt({ type: 'select', message: 'Choose', options: [{ id: 'one', label: 'One' }] }), 'one');
      return valid();
    }, async refresh() {},
  } });
  assert.equal((await auth.status()).state, 'authorized');
  assert.equal(calls, 0);
  await auth.start();
  const p = await until(async () => (await auth.status()).prompt);
  await assert.rejects(auth.answer({ id: p.id, value: 'invalid' }), hasStatus(400));
  await auth.answer({ id: p.id, value: 'one' });
  await settled(auth);
  await auth.close();
  await assert.rejects(auth.start(), hasStatus(410));
});

async function waitingAuth() {
  let interaction, resolve, reject;
  const completion = new Promise((yes, no) => { resolve = yes; reject = no; });
  const auth = createAccountAuth({ credentials: store() }, { oauth: {
    login(value) { interaction = value; return completion; }, async refresh() {},
  } });
  await auth.start();
  await until(() => interaction);
  return { auth, interaction, resolve, reject };
}
const officialUrl = 'https://auth.openai.com/api/accounts/authorize?state=CURRENT_ATTEMPT';

test('authorizationUrl waits for official URL event and cleans all subscriber abort listeners', async () => {
  const { auth, interaction } = await waitingAuth();
  const controller = new AbortController();
  const waits = Array.from({ length: 5 }, () => auth.authorizationUrl({ signal: controller.signal }));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 5);
  let resolved = false;
  waits[0].then(() => { resolved = true; });
  for (const url of ['http://auth.openai.com/authorize', 'https://evil.example/authorize',
    'https://auth.openai.com.evil.example/authorize', 'https://user@auth.openai.com/authorize']) {
    interaction.notify({ type: 'auth_url', url });
  }
  await tick();
  assert.equal(resolved, false);
  interaction.notify({ type: 'auth_url', url: officialUrl });
  assert.deepEqual(await Promise.all(waits), Array(5).fill(officialUrl));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort();
  await auth.close();
  assert.deepEqual((await auth.status()).notices, []);
});

test('authorizationUrl returns existing current URL and never reuses settled attempt URL', async () => {
  const { auth, interaction, resolve } = await waitingAuth();
  interaction.notify({ type: 'auth_url', url: officialUrl });
  const controller = new AbortController();
  assert.equal(await auth.authorizationUrl({ signal: controller.signal, timeoutMs: 0 }), officialUrl);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  resolve(valid());
  await settled(auth);
  await assert.rejects(auth.authorizationUrl(), { code: 'AUTH_NOT_RUNNING' });
  assert.deepEqual((await auth.status()).notices, []);
  await auth.close();
});

test('authorizationUrl default and oversized deadlines stop at fifteen seconds and remove listeners', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { auth } = await waitingAuth();
  for (const options of [{}, { timeoutMs: 999999 }, { timeoutMs: 7 }]) {
    const controller = new AbortController();
    const pending = auth.authorizationUrl({ ...options, signal: controller.signal });
    const rejected = assert.rejects(pending, { code: 'AUTH_URL_TIMEOUT', status: 504 });
    const deadline = options.timeoutMs === 7 ? 7 : 15000;
    t.mock.timers.tick(deadline - 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    t.mock.timers.tick(1);
    await rejected;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal((await auth.status()).state, 'running');
  }
  await auth.close();
});

test('authorizationUrl abort cleans listeners without cancelling the shared login', async () => {
  const { auth, interaction } = await waitingAuth();
  const controller = new AbortController();
  const pending = auth.authorizationUrl({ signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'AUTH_CANCELLED' });
  controller.abort();
  await rejected;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await assert.rejects(auth.authorizationUrl({ signal: controller.signal }), { code: 'AUTH_CANCELLED' });
  assert.equal((await auth.status()).state, 'running');
  interaction.notify({ type: 'auth_url', url: officialUrl });
  assert.equal(await auth.authorizationUrl(), officialUrl);
  await auth.close();
});

test('authorizationUrl rejects on failure, cancel, close and successful settlement before URL', async t => {
  for (const mode of ['failure', 'cancel', 'close', 'success']) {
    await t.test(mode, async () => {
      const { auth, reject, resolve } = await waitingAuth();
      const controller = new AbortController();
      const code = { failure: 'AUTH_FAILED', cancel: 'AUTH_CANCELLED', close: 'AUTH_CLOSED', success: 'AUTH_URL_UNAVAILABLE' }[mode];
      const pending = assert.rejects(auth.authorizationUrl({ signal: controller.signal }), { code });
      if (mode === 'failure') reject(new Error('SECRET_PROVIDER_ERROR'));
      if (mode === 'success') resolve(valid());
      if (mode === 'cancel') await auth.cancel();
      if (mode === 'close') await auth.close();
      await pending;
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      assert.deepEqual((await auth.status()).notices, []);
      await auth.close();
    });
  }
});

test('authorizationUrl wait timers are unrefed and cleared on resolution and abort', async t => {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const timers = new Set();
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    const timer = originalSet(callback, delay, ...args);
    if (delay <= 15000) timers.add(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => {
    timers.delete(timer);
    return originalClear(timer);
  });
  const { auth, interaction } = await waitingAuth();
  const controller = new AbortController();
  const cancelled = assert.rejects(auth.authorizationUrl({ signal: controller.signal }), { code: 'AUTH_CANCELLED' });
  assert.equal(timers.size, 1);
  assert.equal([...timers][0].hasRef(), false);
  controller.abort();
  await cancelled;
  assert.equal(timers.size, 0);
  const pending = auth.authorizationUrl();
  assert.equal(timers.size, 1);
  interaction.notify({ type: 'auth_url', url: officialUrl });
  assert.equal(await pending, officialUrl);
  assert.equal(timers.size, 0);
  await auth.close();
});

test('authorizationUrl rejects without starting an idle or closed account flow', async () => {
  const auth = createAccountAuth({ credentials: store() }, { oauth: {
    async login() { assert.fail('Unexpected login'); }, async refresh() {},
  } });
  await assert.rejects(auth.authorizationUrl(), { code: 'AUTH_NOT_RUNNING', status: 409 });
  await auth.close();
  await assert.rejects(auth.authorizationUrl(), { code: 'AUTH_CLOSED', status: 410 });
});

test('stage diagnostics are sanitized, bounded and refresh failures retain retryable credentials', async () => {
  for (const code of ['AUTH_TOKEN_HTTP_400', 'AUTH_TOKEN_HTTP_401', 'AUTH_TOKEN_HTTP_403', 'AUTH_TOKEN_HTTP_503', 'AUTH_GRANT_SCHEMA', 'AUTH_SCOPE_MISSING', 'OPENAI_NETWORK_TIMEOUT', 'OPENAI_NETWORK_FAILED', 'transport_upstream_error', 'AUTH_DENIED', 'AUTH_TOKEN_HTTP_401_SECRET']) {
    const previous = { kind: 'grant', payload: valid({ expires: 0 }) };
    const credentials = store({ [ACCOUNT]: previous });
    const providerError = Object.assign(new Error('SECRET token=https://secret.invalid'), { code });
    const auth = createAccountAuth({ credentials }, { oauth: { async login() { throw providerError; }, async refresh() { throw providerError; } } });
    await auth.start();
    const status = await settled(auth);
    assert.equal(status.error.code, code.endsWith('_SECRET') ? 'AUTH_FAILED' : code);
    assert.doesNotMatch(JSON.stringify(status), /SECRET|secret.invalid/);
    if (code === 'AUTH_DENIED') assert.match(status.error.message, /\u53d6\u6d88/);
    await assert.rejects(auth.accessToken(), error => {
      assert.equal(error.code, code.endsWith('_SECRET') ? 'AUTH_REFRESH_FAILED' : code);
      assert.doesNotMatch(error.message, /SECRET|secret.invalid/);
      if (['OPENAI_NETWORK_TIMEOUT', 'OPENAI_NETWORK_FAILED', 'transport_upstream_error', 'AUTH_TOKEN_HTTP_503'].includes(code)) assert.equal(error.status, 502);
      return true;
    });
    assert.deepEqual(credentials.records.get(ACCOUNT), previous);
    await auth.close();
  }
});
