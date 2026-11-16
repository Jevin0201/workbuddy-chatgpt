import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuotaReader } from '../quota.js';
import { chromium } from 'playwright';
import { createServerBridge } from '../server.js';
import { quotaWidgetBootstrap } from '../patch-workbuddy.mjs';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
const token = subject => 'header.' + Buffer.from(JSON.stringify({ sub: subject, 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url') + '.signature';

test('quota uses only the currently logged-in plugin token, refreshes and drops old account results', async () => {
  let subject = 'one', calls = 0;
  const auth = { accessToken: async () => token(subject), accountContext: async () => ({ mode: 'subscription', accountId: 'fixture-account' }) };
  const reader = createQuotaReader({ auth, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(options.headers.Authorization, 'Bearer ' + token(subject));
    return Response.json({ rate_limit: { primary_window: { used_percent: 25, reset_at: 2000000000, limit_window_seconds: 18000 } } });
  } });
  assert.equal((await reader.read()).windows[0].remainingPercent, 75);
  await reader.read(); assert.equal(calls, 1);
  await reader.read(undefined, true); assert.equal(calls, 2);
  subject = 'other'; await reader.read(); assert.equal(calls, 3);
  auth.accountContext = async () => ({ mode: undefined });
  assert.equal((await reader.read()).available, false);
  assert.equal(calls, 3);
});

test('quota chip appears at sidebar footer only for connector models and expands', async () => {
  const auth = { status: async () => ({ configured: true }), close: async () => {} };
  const api = { usage: async () => ({ available: true, fetchedAt: Date.now(), windows: [{ name: 'Codex primary', remainingPercent: 75, resetAt: 2000000000, windowSeconds: 18000 }] }) };
  const bridge = createServerBridge({ auth, api, engine: {}, token: 'fixture', port: 0 });
  bridge.server.listen(0, '127.0.0.1'); await once(bridge.server, 'listening');
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const port = bridge.server.address().port;
    const base = 'http://127.0.0.1:' + port;
    const connection = await fetch(base + '/bridge/connect', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Bridge-Desktop': '1' }, body: '{"widget":true}' });
    const quotaSession = (await connection.json()).quotaSession;
    const headers = { 'X-Quota-Session': quotaSession };
    // Electron/WorkBuddy removes Origin after Chromium creates the preflight.
    for (const origin of [undefined, 'null']) {
      const preflight = await fetch(base + '/bridge/usage', { method: 'OPTIONS', headers: {
        ...(origin === undefined ? {} : { Origin: origin }),
        'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-quota-session',
        'Sec-Fetch-Site': 'cross-site',
      } });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), 'null');
    }
    const strippedOrigin = await fetch(base + '/bridge/usage?refresh=1', { headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(strippedOrigin.status, 200);
    assert.equal(strippedOrigin.headers.get('access-control-allow-origin'), 'null');
    assert.equal((await fetch(base + '/bridge/usage', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await fetch(base + '/auth/status', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-quota-session' } })).status, 401);
    assert.equal((await fetch(base + '/bridge/usage?refresh=1', { headers })).status, 200);
    const embedded = await fetch(base + '/bridge/usage?refresh=1', { headers: { ...headers, Origin: 'null', 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(embedded.status, 200);
    assert.equal(embedded.headers.get('access-control-allow-origin'), 'null');
    assert.equal((await fetch(base + '/auth/status', { headers: { ...headers, Origin: 'null' } })).status, 403);
    assert.equal((await fetch(base + '/auth/status', { headers })).status, 401);
    assert.equal((await fetch(base + '/v1/models', { headers })).status, 401);
    await page.route('**/harness', route => route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }));
    await page.goto('http://127.0.0.1:' + port + '/harness');
    await page.setContent('<div class="conversation-list-footer" style="position:fixed;left:0;bottom:0;width:280px;height:60px;background:#ccdfff">Jevin</div>');
    await page.evaluate('(' + quotaWidgetBootstrap.toString().replaceAll('43187', String(port)) + ')()');
    const widget = page.locator('#workbuddy-chatgpt-quota');
    assert.equal(await widget.isVisible(), false);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('workbuddy-chatgpt-model', { detail: 'custom-local:openai:gpt-fixture:default' })));
    await widget.waitFor({ state: 'visible' });
    await page.context().clearCookies();
    const chip = page.frameLocator('#workbuddy-chatgpt-quota').getByRole('button', { name: '额度 · 75%' });
    await chip.click();
    await page.frameLocator('#workbuddy-chatgpt-quota').getByText('5 小时使用限额', { exact: true }).waitFor();
    assert.equal(await widget.evaluate(node => node.getAttribute('sandbox')), 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
    await page.screenshot({ path: fileURLToPath(new URL('../../outputs/quota-widget-success.png', import.meta.url)), fullPage: true });
    await chip.click();
    api.usage = async () => { throw Error('fixture unavailable'); };
    await page.frameLocator('#workbuddy-chatgpt-quota').getByRole('button', { name: '额度 · 75%' }).click();
    const unavailableChip = page.frameLocator('#workbuddy-chatgpt-quota').getByRole('button', { name: '额度 · —' });
    await unavailableChip.waitFor();
    const dimensions = await unavailableChip.evaluate(node => ({ height: node.offsetHeight, width: node.offsetWidth, scroll: node.scrollWidth, client: node.clientWidth, nowrap: getComputedStyle(node).whiteSpace }));
    assert.equal(dimensions.height, 28);
    assert.equal(dimensions.width, 78);
    assert.equal(dimensions.nowrap, 'nowrap');
    assert.ok(dimensions.scroll <= dimensions.client);
    await unavailableChip.click();
    const bounds = await widget.boundingBox();
    assert.ok(bounds.x < 150 && bounds.y > 400);
    await page.screenshot({ path: fileURLToPath(new URL('../../outputs/quota-widget-preview.png', import.meta.url)), fullPage: true });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('workbuddy-chatgpt-model', { detail: 'hy4' })));
    await widget.waitFor({ state: 'hidden' });
  } finally { await browser.close(); await bridge.close(); }
});
