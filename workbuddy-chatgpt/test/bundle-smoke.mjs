import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../outputs/WorkBuddy-ChatGPT-0.4.3-preview/', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'wb-package-smoke-'));
let child;
try {
  const occupied = await fetch('http://127.0.0.1:43187/health').then(() => true, () => false);
  if (occupied) throw new Error('Port already occupied; existing service left untouched');
  child = spawn(join(root, 'node.exe'), [join(root, 'service.js')], { cwd: tmpdir(), env: { ...process.env, LOCALAPPDATA: directory }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', bytes => { errors += bytes; });
  let health;
  for (let attempt = 0; attempt < 40; attempt++) {
    health = await fetch('http://127.0.0.1:43187/health').then(response => response.json(), () => null);
    if (health) break;
    if (child.exitCode !== null) throw new Error('Bundled service exited: ' + errors);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (health?.version !== '0.4.3') throw new Error('Bundled service did not become healthy');
  console.log(JSON.stringify({ bundledRuntime: true, unrelatedWorkingDirectory: true, dshRequired: false, health }));
} finally {
  if (child && child.exitCode === null) { const closed = new Promise(resolve => child.once('close', resolve)); child.kill(); await closed; }
  await rm(directory, { recursive: true, force: true });
}
