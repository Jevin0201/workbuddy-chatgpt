import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { createCurlTokenFetch } from '../curl-token.js';

const URL_TOKEN = 'https://auth.openai.com/api/accounts/oauth/token';
function setup() {
  const calls = [];
  const fetch = createCurlTokenFetch({ proxyUrl: 'http://127.0.0.1:12450', spawnImpl: (...args) => {
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: 0, kill() { this.killed++; } });
    let body = '';
    child.stdin.on('data', data => { body += data; });
    calls.push({ args, child, body: () => body });
    return child;
  } });
  return { fetch, calls };
}
const request = { method: 'POST', body: 'code=secret-code&refresh_token=secret-token' };
function complete(child, output = '{"error":"invalid_grant"}\n400', code = 0) {
  child.stdout.end(output);
  child.emit('close', code);
}

test('stdin secrets, fixed command and HTTP400 preservation without retry', async () => {
  const { fetch, calls } = setup();
  const pending = fetch(URL_TOKEN, { ...request, headers: { Authorization: 'secret' } });
  assert.equal(calls[0].body(), request.body);
  assert.equal(JSON.stringify(calls[0].args).includes('secret'), false);
  assert.equal(calls[0].args[0], path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe'));
  assert.deepEqual(calls[0].args[2], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  assert.deepEqual(calls[0].args[1], ['--silent', '--show-error', '--connect-timeout', '15', '--max-time', '45', '--max-redirs', '0', '--request', 'POST', '--url', URL_TOKEN, '--proxy', 'http://127.0.0.1:12450', '--header', 'Content-Type: application/x-www-form-urlencoded', '--data-binary', '@-', '--write-out', '\n%{http_code}']);
  complete(calls[0].child);
  const response = await pending;
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.deepEqual(await response.json(), { error: 'invalid_grant' });
  assert.equal(calls.length, 1);
});

test('exact destinations and bounded form bodies only', async () => {
  const { fetch, calls } = setup();
  for (const url of ['http://auth.openai.com/oauth/token', URL_TOKEN + '?', URL_TOKEN + '#x', URL_TOKEN + '/x', 'https://user:secret@auth.openai.com/oauth/token', 'https://auth.openai.com:443/oauth/token', 'https://evil.example/oauth/token']) {
    await assert.rejects(fetch(url, request), { code: 'transport_request_error' });
  }
  for (const init of [{ ...request, method: 'GET' }, { body: 'x' }, { ...request, body: {} }, { ...request, body: '\u00e9'.repeat(524289) }]) {
    await assert.rejects(fetch(URL_TOKEN, init), { code: 'transport_request_error' });
  }
  assert.equal(calls.length, 0);
  const pending = fetch('https://auth.openai.com/oauth/token', { method: 'POST', body: new URLSearchParams({ code: 'fixture' }) });
  complete(calls[0].child, '{}\n200');
  assert.equal((await pending).status, 200);
});

test('proxy rejects credentials, alternate protocols and argument-like values', () => {
  for (const proxyUrl of ['http://user:secret@localhost:1', 'http://@localhost:1', 'socks5://localhost:1', 'http://localhost:1/path', 'http://localhost:1?', 'http://localhost:1#', 'http://localhost:1 --verbose', '', null]) {
    assert.throws(() => createCurlTokenFetch({ proxyUrl }), { code: 'transport_config_error' });
  }
});

test('abort kills only owned child and removes listener; late errors are handled', async () => {
  const { fetch, calls } = setup();
  const controller = new AbortController();
  let listeners = 0;
  const signal = { get aborted() { return controller.signal.aborted; }, addEventListener(...args) { listeners++; controller.signal.addEventListener(...args); }, removeEventListener(...args) { listeners--; controller.signal.removeEventListener(...args); } };
  const first = fetch(URL_TOKEN, { ...request, signal });
  const second = fetch(URL_TOKEN, request);
  controller.abort('secret reason');
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(calls[0].child.killed, 1);
  assert.equal(calls[1].child.killed, 0);
  assert.equal(listeners, 0);
  calls[0].child.stdin.emit('error', new Error('late secret'));
  complete(calls[1].child);
  await second;
  await assert.rejects(fetch(URL_TOKEN, { ...request, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.length, 2);
});

test('output limit, malformed status and child errors are sanitized', async () => {
  for (const [output, code] of [['secret\n400', 1], ['secret\n100', 0], ['secret\n600', 0], ['secret\n200x', 0], ['secret\n\u00b2\u00b0\u00b0', 0], ['secret', 0], ['x'.repeat(1024 * 1024 + 4097), 0]]) {
    const { fetch, calls } = setup();
    const pending = fetch(URL_TOKEN, request);
    calls[0].child.stderr.write('secret stderr');
    complete(calls[0].child, output, code);
    await assert.rejects(pending, error => error.code === 'transport_upstream_error' && !error.stack.includes('secret') && error.cause === undefined);
  }
  for (const stream of ['stdin', 'stdout', 'stderr', null]) {
    const { fetch, calls } = setup();
    const pending = fetch(URL_TOKEN, request);
    (stream ? calls[0].child[stream] : calls[0].child).emit('error', new Error('secret details'));
    await assert.rejects(pending, error => error.code === 'transport_upstream_error' && !error.stack.includes('secret'));
  }
  const fetch = createCurlTokenFetch({ proxyUrl: 'https://localhost:1', spawnImpl() { throw new Error('secret'); } });
  await assert.rejects(fetch(URL_TOKEN, request), { code: 'transport_upstream_error' });
});

test('boundary-sized response and null-body statuses are supported', async () => {
  for (const [output, status] of [['x'.repeat(1024 * 1024 + 4092) + '\n599', 599], ['\n204', 204], ['\n205', 205], ['\n304', 304]]) {
    const { fetch, calls } = setup();
    const pending = fetch(URL_TOKEN, request);
    complete(calls[0].child, output);
    assert.equal((await pending).status, status);
  }
});
