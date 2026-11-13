import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(root, '..', 'outputs', 'WorkBuddy-ChatGPT-0.4.3-preview');
fs.mkdirSync(target, { recursive: true });
for (const name of fs.readdirSync(root)) {
  if (/\.(js|mjs|ps1|cmd|md|json)$/.test(name) && !['build.mjs','settings.json'].includes(name)) {
    const destination = path.join(target, name);
    // Windows PowerShell 5.1 requires a BOM for Chinese script strings.
    if (name.endsWith('.ps1')) fs.writeFileSync(destination, '\uFEFF' + fs.readFileSync(path.join(root, name), 'utf8').replace(/^\uFEFF/, ''));
    else fs.copyFileSync(path.join(root, name), destination);
  }
}
// Browser-test tools are development dependencies, not part of the connector.
const modules = path.join(target, 'node_modules');
fs.mkdirSync(modules, { recursive: true });
fs.cpSync(path.join(root, 'node_modules', 'undici'), path.join(modules, 'undici'), { recursive: true });
fs.copyFileSync(process.execPath, path.join(target, 'node.exe'));
console.log(target);
