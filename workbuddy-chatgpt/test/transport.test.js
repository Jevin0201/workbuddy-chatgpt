import test from 'node:test';
import assert from 'node:assert/strict';
import { createScopedTransport } from '../transport.js';
import { BridgeError } from '../errors.js';

function setup(proxyUrl = 'http://127.0.0.1:12450', fetchImpl) {
  const agents = [];
  const calls = [];
  class ProxyAgent {
    constructor(options) { this.options = options; this.closed = 0; agents.push(this); }
    async close() { this.closed++; }
  }
  const transport = createScopedTransport({ proxyUrl, ProxyAgent, fetchImpl: fetchImpl ?? (async (...args) => { calls.push(args); return 'response'; }) });
  return { transport, agents, calls };
}

test('approved routes share one scoped proxy and force redirect errors', async () => {
  const { transport, agents, calls } = setup();
  const routes = [
    ['https://auth.openai.com/api/accounts/oauth/token', 'POST'],
    ['https://auth.openai.com/oauth/token', 'POST'],
    ['https://api.openai.com/v1/models', 'GET'],
    ['https://api.openai.com/v1/responses', 'POST'],
    ['https://chatgpt.com/backend-api/wham/usage', 'GET'],
  ];
  for (const [url, method] of routes) {
    assert.equal(await transport.fetch(new URL(url), { method, redirect: 'follow', dispatcher: 'foreign', headers: { Authorization: 'Bearer fixture' } }), 'response');
  }
  assert.equal(agents.length, 1);
  assert.deepEqual(agents[0].options, { uri: 'http://127.0.0.1:12450' });
  calls.forEach(([url, init], i) => {
    assert.equal(url, routes[i][0]);
    assert.equal(typeof url, 'string');
    assert.equal(init.dispatcher, agents[0]);
    assert.equal(init.redirect, 'error');
    assert.equal(init.rejectUnauthorized, undefined);
    assert.equal(init.headers.Authorization, 'Bearer fixture');
  });
  await transport.close();
});

test('rejects unrelated destinations, URL adornments, Requests and wrong methods before fetch', async () => {
  const { transport, calls } = setup();
  const invalid = [
    'garbage', 'http://api.openai.com/v1/models', 'https://evil.example/v1/models',
    'https://api.openai.com.evil.example/v1/models', 'https://api.openai.com:444/v1/models',
    'https://api.openai.com/v1/models/extra', 'https://auth.openai.com/.well-known/openid-configuration',
    'https://chatgpt.com/backend-api/codex/models', 'https://api.openai.com/v1/models?q=1',
    'https://api.openai.com/v1/models?', 'https://api.openai.com/v1/models#',
    'https://user:secret@api.openai.com/v1/models', new Request('https://api.openai.com/v1/models'),
    { toString: () => 'https://api.openai.com/v1/models' },
  ];
  for (const url of invalid) await assert.rejects(transport.fetch(url), { code: 'transport_request_error', status: 400 });
  for (const method of ['POST', 'get', 'HEAD', 'DELETE']) await assert.rejects(transport.fetch('https://api.openai.com/v1/models', { method }), { code: 'transport_request_error' });
  await assert.rejects(transport.fetch('https://api.openai.com/v1/responses'), { code: 'transport_request_error' });
  assert.equal(calls.length, 0);
  await transport.close();
});

test('direct mode overrides caller dispatcher without creating an agent', async () => {
  const { transport, agents, calls } = setup('');
  await transport.fetch('https://api.openai.com/v1/models', { dispatcher: 'foreign' });
  assert.equal(agents.length, 0);
  assert.equal(calls[0][1].dispatcher, undefined);
  assert.equal(calls[0][1].redirect, 'error');
  await transport.close();
});

test('proxy validation and network failures never expose credentials or raw errors', async () => {
  for (const proxyUrl of ['socks5://localhost:1', 'http://localhost:1/path', 'http://localhost:1?', 'http://localhost:1#', 'http://localhost:1 --arg', {}, null]) {
    assert.throws(() => setup(proxyUrl), error => error instanceof BridgeError && error.code === 'transport_config_error' && !error.message.includes('localhost'));
  }
  const { transport, agents } = setup('http://user:proxy-secret@127.0.0.1:12450', async () => { throw new Error('proxy-secret raw socket details'); });
  assert.deepEqual(Object.keys(agents[0].options), ['uri']);
  await assert.rejects(transport.fetch('https://api.openai.com/v1/models'), error => error instanceof BridgeError && error.status === 502 && !JSON.stringify(error).includes('proxy-secret') && !error.stack.includes('proxy-secret') && error.cause === undefined);
  await transport.close();
});

test('close owns one agent, is idempotent, and rejects later fetches', async () => {
  const { transport, agents, calls } = setup();
  const first = transport.close();
  assert.equal(transport.close(), first);
  await first;
  await transport.close();
  assert.equal(agents[0].closed, 1);
  await assert.rejects(transport.fetch('https://api.openai.com/v1/models'), { code: 'transport_closed', status: 503 });
  assert.equal(calls.length, 0);
});

test('shutdown and constructor errors are sanitized', async () => {
  class BrokenAgent { constructor() { throw new Error('proxy-secret'); } }
  assert.throws(() => createScopedTransport({ proxyUrl: 'http://localhost:12450', ProxyAgent: BrokenAgent }), { message: 'Proxy configuration is invalid' });
  class CloseAgent { close() { throw new Error('proxy-secret'); } }
  const transport = createScopedTransport({ proxyUrl: 'http://localhost:12450', ProxyAgent: CloseAgent });
  await assert.rejects(transport.close(), { message: 'Transport shutdown failed', code: 'transport_close_error' });
});
