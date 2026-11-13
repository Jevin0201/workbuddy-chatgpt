import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialStore, protect } from '../credentials.js';
import { syncModels } from '../workbuddy.js';
import { createEngine } from '../engine.js';
import { startService } from '../service.js';

test('Windows credential protection roundtrips without plaintext at rest', async () => {
  const input = Buffer.from('fixture-secret');
  const encrypted = await protect(input);
  assert.equal(encrypted.includes(input), false);
  assert.deepEqual(await protect(encrypted, true), input);
});
test('standalone credential store serializes concurrent updates and retains installation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wb-credentials-'));
  try {
    const store = createCredentialStore(directory, async bytes => bytes);
    await Promise.all([store.modifyRecord('installation', () => ({ id: 'fixture' })), store.modifyRecord('account', () => ({ account: 'fixture' }))]);
    assert.deepEqual(await store.readRecord('installation'), { id: 'fixture' });
    assert.deepEqual(await store.readRecord('account'), { account: 'fixture' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('models retain native reasoning capabilities, stable identity and disabled switch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wb-models-'));
  try {
    const target = join(directory, 'models.json');
    const catalog = { models: [{ id: 'fixture', name: 'Fixture', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' } }] };
    await syncModels({ selections: [{ id: 'fixture', enabled: false }], catalog, token: 'fixture-key', port: 43187, target });
    const [entry] = JSON.parse(await readFile(target, 'utf8'));
    assert.equal(entry.disabled, true);
    assert.equal(entry.id, 'openai:fixture:default');
    assert.deepEqual(entry.reasoning, { supportedEfforts: ['low', 'high'], defaultEffort: 'high' });
    await syncModels({ selections: [], catalog, token: 'fixture-key', port: 43187, target });
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('conversation effort overrides go upstream without DSH or effort aliases', async () => {
  let request;
  const api = { models: async () => ({ models: [{ id: 'fixture', reasoning: { efforts: [{ id: 'high' }] } }] }), async *streamResponses(body) { request = body; yield { type: 'response.completed', response: { status: 'completed', output: [] } }; } };
  const prepared = await createEngine({ api }).prepare({ model: 'openai:fixture:default', messages: [{ role: 'user', content: 'hello' }], reasoning_effort: 'high' });
  for await (const chunk of prepared.chunks()) void chunk;
  assert.equal(request.model, 'fixture');
  assert.equal(request.reasoning.effort, 'high');
});

test('standalone service starts with no DSH and restricts inference to its bearer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wb-service-'));
  const service = await startService({ directory, port: 51389 });
  try {
    const base = `http://127.0.0.1:${service.port}`;
    assert.equal((await (await fetch(base + '/health')).json()).version, '0.4.3');
    assert.equal((await fetch(base + '/v1/models')).status, 401);
    const connected = await fetch(base + '/bridge/connect', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Bridge-Desktop': '1' }, body: '{}' });
    assert.equal(connected.status, 200);
    const status = await fetch(base + '/auth/status', { headers: { Cookie: connected.headers.get('set-cookie').split(';')[0] } });
    assert.equal((await status.json()).configured, false);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
