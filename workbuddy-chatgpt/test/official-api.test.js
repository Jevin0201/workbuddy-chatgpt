import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfficialApi } from '../official-api.js';

const TOKEN = 'fixture-secret-access-token';
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const sse = text => new Response(text, { headers: { 'content-type': 'text/event-stream' } });
const event = value => `data: ${JSON.stringify(value)}\n\n`;
const collect = async iterable => { const result = []; for await (const item of iterable) result.push(item); return result; };
function setup(fetchImpl, extras = {}) {
  const calls = [];
  const auth = { accessToken: async signal => { calls.push(signal); return TOKEN; } };
  return { api: createOfficialApi({ auth, fetchImpl, ...extras }), calls };
}

test('account model catalog is dynamic, visible only, and preserves actual metadata', async () => {
  const signal = new AbortController().signal;
  const { api, calls } = setup(async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/models');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.signal, signal);
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    return json({ models: [
      { slug: 'actualTerra', title: 'Actual Terra', visibility: 'list', context_window: 400000, max_output_tokens: 12000, input_modalities: ['text', 'image'], supported_reasoning_levels: [{ effort: 'maximum', description: 'Maximum reasoning' }], default_reasoning_level: 'maximum' },
      { slug: 'hidden', visibility: 'hidden' },
      ...Array.from({ length: 12 }, (_, i) => ({ slug: `returned-${i}`, visibility: 'list' })),
    ] });
  }, { now: () => 1_700_000_000_000 });
  const result = await api.models({ signal });
  assert.equal(result.models.length, 13);
  assert.deepEqual(result.models[0], { id: 'actualTerra', name: 'Actual Terra', contextWindow: 400000, maxTokens: 12000, inputModalities: ['text', 'image'], reasoning: { efforts: [{ id: 'maximum', name: 'Maximum reasoning' }], defaultEffort: 'maximum', source: 'reported' } });
  assert.deepEqual(result.models[1].reasoning, { efforts: [], source: 'unreported' });
  assert.equal(result.source, 'account');
  assert.equal(result.fetchedAt, '2023-11-14T22:13:20.000Z');
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(calls, [signal]);
});

test('reasoning variants are read only from genuine declared shapes', async () => {
  const rows = [
    { reasoning_efforts: ['minimal', 'xhigh'], default_reasoning_level: 'xhigh' },
    { supported_reasoning_efforts: ['none', 'custom'], default_reasoning_level: 'invented' },
    { reasoning: { efforts: [{ id: 'thinking', name: 'Think deeply' }], defaultEffort: 'thinking' } },
    { supported_reasoning_levels: ['low', 'high'] },
    { reasoning_efforts: [{ effort: 'low' }] },
    { supported_reasoning_efforts: [{ id: 'low' }] },
    { reasoning: { efforts: ['low', 'high'] } },
    { default_reasoning_level: 'high' },
    { reasoning_efforts: [] },
    { supported_reasoning_levels: [{ effort: 'ultra', description: 'Ultra' }], default_reasoning_level: { effort: 'ultra' } },
  ];
  const { api } = setup(async () => json({ models: rows.map((row, i) => ({ slug: `m${i}`, visibility: 'list', ...row })) }));
  const { models } = await api.models();
  assert.deepEqual(models[0].reasoning, { efforts: [{ id: 'minimal', name: 'minimal' }, { id: 'xhigh', name: 'xhigh' }], defaultEffort: 'xhigh', source: 'reported' });
  assert.deepEqual(models[1].reasoning, { efforts: [{ id: 'none', name: 'none' }, { id: 'custom', name: 'custom' }], source: 'reported' });
  assert.deepEqual(models[2].reasoning, { efforts: [{ id: 'thinking', name: 'Think deeply' }], defaultEffort: 'thinking', source: 'reported' });
  for (let i = 3; i <= 7; i++) assert.deepEqual(models[i].reasoning, { efforts: [], source: 'unreported' });
  assert.deepEqual(models[8].reasoning, { efforts: [], source: 'reported' });
  assert.equal(models[9].reasoning.defaultEffort, undefined);
});

test('reject API-key catalog and unknown account schemas', async () => {
  for (const payload of [{ data: [{ id: 'api-only' }] }, {}, { models: null }, { models: [{ visibility: 'list' }] }]) {
    const { api } = setup(async () => json(payload));
    await assert.rejects(api.models(), { code: 'invalid_model_schema' });
  }
});

test('cache returns independent snapshots, force refreshes, and TTL expires', async () => {
  let hits = 0;
  let clock = 0;
  const { api } = setup(async () => { hits++; return json({ models: [{ slug: 'fresh', visibility: 'list' }] }); }, { now: () => clock });
  const first = await api.models();
  first.models.length = 0;
  assert.equal((await api.models()).models.length, 1);
  assert.equal(hits, 1);
  await api.models({ force: true });
  assert.equal(hits, 2);
  clock = 60_001;
  await api.models();
  assert.equal(hits, 3);
});

test('quota is explicitly unavailable without an evidenced endpoint and never sends a token', async () => {
  const { api, calls } = setup(async () => { throw new Error('unexpected fetch'); });
  assert.deepEqual(await api.usage({ force: true }), { available: false, reason: 'subscription_quota_unreported' });
  assert.equal(calls.length, 0);
});

test('HTTP, network, auth, and JSON errors never expose upstream diagnostics or credentials', async () => {
  const cases = [
    async () => new Response(`upstream private ${TOKEN}`, { status: 401 }),
    async () => { throw new Error(`network private ${TOKEN}`); },
    async () => new Response(`invalid JSON ${TOKEN}`),
    async () => new Response(TOKEN, { status: 429 }),
  ];
  for (const fetchImpl of cases) {
    const { api } = setup(fetchImpl);
    await assert.rejects(api.models(), error => !String(error).includes(TOKEN) && !String(error).includes('private'));
  }
  const api = createOfficialApi({ auth: { accessToken: async () => { throw new Error(TOKEN); } }, fetchImpl: async () => assert.fail() });
  await assert.rejects(api.models(), error => error.status === 401 && !String(error).includes(TOKEN));
});

test('JSON response is limited to four MiB even without content-length', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); }, cancel() { cancelled = true; } });
  const { api } = setup(async () => new Response(body));
  await assert.rejects(api.models(), /size limit/);
  assert.equal(cancelled, true);
});

test('oversized declared JSON length discards body before parsing', async () => {
  const { api } = setup(async () => new Response('{}', { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } }));
  await assert.rejects(api.models(), /size limit/);
});

test('stream fixes transport and parses arbitrary byte boundaries, CRLF, UTF8, and multiline data', async () => {
  const original = { model: 'actualTerra', input: 'Hello', stream: false, reasoning: { effort: 'custom' } };
  const signal = new AbortController().signal;
  const wire = ': keepalive\r\nevent: response.output_text.delta\r\ndata: {"delta":\r\ndata: "Hello \u4e16\u754c"}\r\n\r\n' + event({ type: 'response.completed', response: { id: 'r1', status: 'completed' } });
  const bytes = new TextEncoder().encode(wire);
  const { api } = setup(async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.signal, signal);
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(JSON.parse(options.body).stream, true);
    assert.equal(JSON.parse(options.body).reasoning.effort, 'custom');
    let offset = 0;
    return new Response(new ReadableStream({ pull(controller) { if (offset === bytes.length) controller.close(); else controller.enqueue(bytes.slice(offset, ++offset)); } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  });
  const result = await collect(api.streamResponses(original, { signal }));
  assert.deepEqual(result[0], { type: 'response.output_text.delta', delta: 'Hello \u4e16\u754c' });
  assert.equal(result[1].type, 'response.completed');
  assert.equal(original.stream, false);
});

test('failed and incomplete terminals remain explicit with sanitized details', async () => {
  for (const type of ['response.failed', 'response.incomplete']) {
    const { api } = setup(async () => sse(event({ type, response: { id: 'r1', status: type.slice(9), error: { message: `private ${TOKEN}` }, incomplete_details: { reason: 'max_output_tokens' }, usage: { output_tokens: 3 } } })));
    const [result] = await collect(api.streamResponses({ model: 'm' }));
    assert.equal(result.type, type);
    assert.equal(result.response.status, type.slice(9));
    assert.equal(result.response.usage.output_tokens, 3);
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
    assert.equal(JSON.stringify(result).includes('private'), false);
    if (type === 'response.incomplete') assert.equal(result.response.incomplete_details.reason, 'max_output_tokens');
  }
});

test('error events are terminal and generic rather than leaked diagnostic text', async () => {
  const { api } = setup(async () => sse(event({ type: 'error', message: TOKEN, error: { message: 'private' } })));
  const result = await collect(api.streamResponses({}));
  assert.deepEqual(result, [{ type: 'error', error: { message: 'OpenAI stream reported an error', code: 'upstream_error' } }]);
});

test('raw token is redacted from successful model and stream data', async () => {
  const { api } = setup(async () => json({ models: [{ slug: 'm', visibility: 'list', title: TOKEN }] }));
  assert.equal(JSON.stringify(await api.models()).includes(TOKEN), false);
  const other = setup(async () => sse(event({ type: 'response.output_text.delta', delta: TOKEN }) + event({ type: 'response.completed' })));
  assert.equal(JSON.stringify(await collect(other.api.streamResponses({}))).includes(TOKEN), false);
});

test('truncated, DONE-only, malformed JSON, and wrong-content streams fail explicitly', async () => {
  for (const wire of [event({ type: 'response.output_text.delta', delta: 'partial' }), 'data: [DONE]\n\n', 'data: {broken}\n\n', 'data: {"type":"response.completed"}']) {
    const { api } = setup(async () => sse(wire));
    await assert.rejects(collect(api.streamResponses({})), error => error.status === 502);
  }
  const { api } = setup(async () => json({ type: 'response.completed' }));
  await assert.rejects(collect(api.streamResponses({})), /content type/);
});

test('one SSE event is limited to eight MiB including non-data lines', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(':' + 'x'.repeat(8 * 1024 * 1024))); }, cancel() { cancelled = true; } });
  const { api } = setup(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
  await assert.rejects(collect(api.streamResponses({})), /size limit/);
  assert.equal(cancelled, true);
});

test('preaborted operations send neither auth nor network requests', async () => {
  const controller = new AbortController();
  controller.abort(TOKEN);
  const { api, calls } = setup(async () => assert.fail());
  await assert.rejects(api.models({ signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(api.usage({ signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(collect(api.streamResponses({}, { signal: controller.signal })), { name: 'AbortError' });
  assert.equal(calls.length, 0);
});

test('abort propagates to fetch and cancels a stalled stream read', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const { api } = setup(async (_url, options) => {
    assert.equal(options.signal, controller.signal);
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const iterator = api.streamResponses({}, { signal: controller.signal });
  const next = iterator.next();
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(TOKEN);
  await assert.rejects(next, error => error.name === 'AbortError' && !String(error).includes(TOKEN));
  assert.equal(cancelled, true);
});

test('attribution headers are accepted but cannot replace Authorization or Host', async () => {
  const { api } = setup(async (url, options) => {
    const headers = new Headers(options.headers);
    assert.equal(headers.get('authorization'), `Bearer ${TOKEN}`);
    assert.equal(headers.get('host'), null);
    assert.equal(headers.get('x-attribution'), 'fixture');
    assert.equal(headers.get('accept'), 'application/json');
    return json({ models: [] });
  }, { extraHeaders: async () => ({ AUTHORIZATION: 'attacker', HOST: 'elsewhere.test', 'X-Attribution': 'fixture', Accept: 'text/plain' }) });
  await api.models();
});

test('separate quota provider owns its grant and preserves sanitized quantities', async () => {
  const signal = new AbortController().signal;
  const expected = { available: true, source: 'codex', windows: [{ percentRemaining: 25, resetAt: 1700000000 }], credits: { balance: '12.50', unit: 'credits', unlimited: false } };
  const { api, calls } = setup(async () => assert.fail(), { quotaProvider: async passed => { assert.equal(passed, signal); return expected; } });
  const actual = await api.usage({ signal });
  assert.deepEqual(actual, expected);
  assert.notEqual(actual, expected);
  assert.equal(calls.length, 0);
  const other = setup(async () => assert.fail(), { quotaProvider: async () => { throw new Error(TOKEN); } });
  assert.deepEqual(await other.api.usage(), { available: false, reason: 'subscription_quota_unavailable' });
});

test('catalog cache cannot hide logout or return another account catalog', async () => {
  let token = 'first';
  let hits = 0;
  const api = createOfficialApi({ auth: { accessToken: async () => token }, fetchImpl: async (_url, options) => { hits++; return json({ models: [{ slug: options.headers.Authorization, visibility: 'list' }] }); } });
  await api.models();
  token = undefined;
  await assert.rejects(api.models(), error => error.status === 401);
  token = 'second';
  await api.models();
  assert.equal(hits, 2);
});

test('consumer early return cancels underlying response stream', async () => {
  let cancelled = false;
  const { api } = setup(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(event({ type: 'response.output_text.delta', delta: 'x' }))); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }));
  for await (const item of api.streamResponses({})) { assert.equal(item.delta, 'x'); break; }
  assert.equal(cancelled, true);
});
