import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transformModelDisplay } from '../patch-workbuddy.mjs';
import { syncModels } from '../workbuddy.js';
import { createOfficialApi } from '../official-api.js';

test('connector labels show names while unrelated custom labels retain their IDs', () => {
  const source = 'function getModelDisplayName(e,t){let n=WEt[e.id];if(n)return t(n);if(isCustomModel(e)){let t=stripCustomLocalPrefix(e.id),n=UEt[t]||t;return!e.name||e.name===n?n:`${e.name}:${n}`}return(e.name||e.id)}';
  const display = vm.runInNewContext(transformModelDisplay(source) + ';getModelDisplayName', { WEt: {}, UEt: {}, isCustomModel: () => true, stripCustomLocalPrefix: id => id.replace('custom-local:', '') });
  assert.equal(display({ id: 'custom-local:openai:gpt-6.1-sol:default', name: 'GPT-6.1-Sol' }), 'GPT-6.1 Sol');
  assert.equal(display({ id: 'custom-local:openai:gpt-6.1-terra:default', name: 'GPT-6.1 Terra' }), 'GPT-6.1 Terra');
  assert.equal(display({ id: 'custom-local:other', name: 'Other' }), 'Other:other');
});

test('sync disables only duplicate old DSH entries and keeps current reasoning efforts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wb-clean-models-'));
  try {
    const target = join(directory, 'models.json');
    const old = { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', url: 'http://127.0.0.1:51380/v1/chat/completions', dshBridge: true };
    const unrelated = { id: 'unrelated', name: 'Unrelated', url: 'https://example.invalid' };
    await writeFile(target, JSON.stringify([old, unrelated]));
    const catalog = { models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }] };
    await syncModels({ selections: [{ id: 'gpt-6.1-sol' }], catalog, token: 'fixture', port: 43187, target });
    const result = JSON.parse(await readFile(target, 'utf8'));
    assert.equal(result[0].disabled, true);
    assert.deepEqual(result[1], unrelated);
    assert.equal(result[2].name, 'GPT-6.1 Sol');
    assert.deepEqual(result[2].reasoning.supportedEfforts, ['low', 'high']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('valid SSE without Content-Type is accepted but missing terminal remains an error', async () => {
  const make = content => {
    const response = new Response(content); response.headers.delete('content-type');
    return createOfficialApi({ auth: { accessToken: async () => 'fixture' }, fetchImpl: async () => response });
  };
  const api = make('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n');
  const events = [];
  for await (const event of api.streamResponses({ model: 'fixture' })) events.push(event);
  assert.equal(events.at(-1).type, 'response.completed');
  await assert.rejects(async () => { for await (const event of make('not SSE').streamResponses({ model: 'fixture' })) void event; });
});
