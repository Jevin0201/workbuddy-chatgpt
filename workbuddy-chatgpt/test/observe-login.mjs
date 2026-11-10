import { chromium } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startService } from '../service.js';
const directory = await mkdtemp(join(tmpdir(), 'wb-login-observe-'));
const service = await startService({ directory, port: 51387 });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage();
try {
  await page.goto('http://127.0.0.1:51387/');
  await page.getByText('尚未登录 ChatGPT', { exact: true }).waitFor();
  await page.getByRole('button', { name: '登录ChatGPT', exact: true }).click();
  let navigationError = false;
  await page.waitForURL(url => url.hostname === 'auth.openai.com', { timeout: 25000 }).catch(() => { navigationError = true; });
  await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
  const origin = new URL(page.url()).origin;
  const text = await page.locator('body').innerText().catch(() => '');
  const result = { origin, navigationError, title: await page.title(), loginInputVisible: await page.locator('input[type=email],input[name=username]').count() > 0, challengeVisible: /verify you are human|checking your browser|just a moment|验证您|人机|Cloudflare/i.test(text), accountLoginPerformed: false };
  const evidence = fileURLToPath(new URL('../../outputs/test-evidence/', import.meta.url));
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, 'official-login.png'), fullPage: true });
  await writeFile(join(evidence, 'official-login.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
