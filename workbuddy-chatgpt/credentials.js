import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

// Windows DPAPI CurrentUser: no plaintext credentials on disk or command line.
export function protect(value, decrypt = false) {
  const operation = decrypt ? 'Unprotect' : 'Protect';
  const script = `Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($s); $r=[Security.Cryptography.ProtectedData]::${operation}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  return new Promise((resolve, reject) => {
    const child = spawn(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const parts = []; let size = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('Credential encryption timed out')); }, 15000);
    child.stdout.on('data', data => { size += data.length; if (size > 1024 * 1024) child.kill(); else parts.push(data); });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(new Error('Windows credential encryption unavailable')); });
    child.on('close', code => { clearTimeout(timer); if (code !== 0 || size > 1024 * 1024) reject(new Error('Windows credential encryption failed')); else resolve(Buffer.from(Buffer.concat(parts).toString().trim(), 'base64')); });
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.from(value).toString('base64'));
  });
}

export function createCredentialStore(directory, crypt = protect) {
  let tail = Promise.resolve();
  const file = join(directory, 'account.dpapi');
  async function read() {
    let bytes;
    try { bytes = await readFile(file); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
    return JSON.parse((await crypt(bytes, true)).toString('utf8'));
  }
  return {
    async readRecord(key) { await tail; return (await read())[key]; },
    modifyRecord(key, modifier) {
      const operation = tail.then(async () => {
        const data = await read();
        const next = await modifier(data[key]);
        if (next === undefined) return data[key];
        data[key] = next;
        await mkdir(directory, { recursive: true });
        const temporary = join(directory, `credential-${randomUUID()}.tmp`);
        await writeFile(temporary, await crypt(Buffer.from(JSON.stringify(data))), { flag: 'wx', mode: 0o600 });
        await rename(temporary, file);
        return next;
      });
      tail = operation.catch(() => {});
      return operation;
    },
  };
}
