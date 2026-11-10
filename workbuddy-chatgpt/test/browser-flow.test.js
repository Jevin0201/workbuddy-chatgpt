import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createServerBridge } from '../server.js';
import { createEngine } from '../engine.js';

test('Chrome page loads account models, toggles persist on reload, inference passes selected effort', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wb-browser-'));
  const target = join(directory, 'models.json');
  const catalog = { models: [{ id: 'fixture-model', name: '测试模型', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' } }] };
  const requests = [];
  const api = { models: async () => catalog, async *streamResponses(body) { requests.push(body); yield { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'fixture reply' }] }] } }; } };
  const auth = { status: async () => ({ configured: true, state: 'authorized' }), close: async () => {} };
  const bridge = createServerBridge({ auth, api, engine: createEngine({ api }), token: 'fixture-bearer', port: 0, workbuddyTarget: target });
  bridge.server.listen(0, '127.0.0.1'); await once(bridge.server, 'listening');
  const base = `http://127.0.0.1:${bridge.server.address().port}`;
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(base);
    await page.getByRole('checkbox', { name: '显示 测试模型' }).waitFor();
    await page.getByText('已保存到 WorkBuddy。', { exact: true }).waitFor();
    await page.getByRole('checkbox').uncheck();
    await page.getByText('已保存到 WorkBuddy。', { exact: true }).waitFor();
    assert.equal(JSON.parse(await readFile(target, 'utf8'))[0].disabled, true);
    await page.reload();
    await page.getByText('已保存到 WorkBuddy。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('checkbox').isChecked(), false);
    await page.getByRole('checkbox').check();
    await page.getByText('已保存到 WorkBuddy。', { exact: true }).waitFor();
    const [entry] = JSON.parse(await readFile(target, 'utf8'));
    assert.deepEqual(entry.reasoning.supportedEfforts, ['low', 'high']);
    for (const effort of ['low', 'high']) {
      const response = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer fixture-bearer', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: entry.id, messages: [{ role: 'user', content: 'test' }], reasoning_effort: effort }) });
      assert.equal(response.status, 200); assert.equal((await response.json()).choices[0].message.content, 'fixture reply');
      assert.equal(requests.at(-1).reasoning.effort, effort);
    }
    const evidence = new URL('../../outputs/test-evidence/', import.meta.url);
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: join(fileURLToPath(evidence), 'model-switches.png'), fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await bridge.close(); await rm(directory, { recursive: true, force: true }); }
});
