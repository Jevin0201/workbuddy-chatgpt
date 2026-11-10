import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { run, EXPECTED } from '../patch-workbuddy.mjs';

test('real 5.9.3 artifact copies install and roll back exactly; unknown changes block restoration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-patch-cycle-'));
  const archive = path.join(root, 'resources', 'app.asar');
  const executable = path.join(root, 'WorkBuddy.exe');
  const suffix = '.dsh-codex-bridge-5.9.3.original';
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const output = console.log;
  console.log = () => {};
  try {
    fs.mkdirSync(path.dirname(archive));
    fs.copyFileSync('C:/Program Files/WorkBuddy/resources/app.asar' + suffix, archive);
    fs.copyFileSync('C:/Program Files/WorkBuddy/WorkBuddy.exe' + suffix, executable);
    run(['--apply', '--archive', archive, '--exe', executable, '--confirm-workbuddy-closed', '--accept-signature-change']);
    assert.notEqual(hash(archive), EXPECTED.archiveSha256);
    assert.notEqual(hash(executable), EXPECTED.executableSha256);
    const valid = fs.readFileSync(executable);
    const changed = Buffer.from(valid); changed[0] ^= 1; fs.writeFileSync(executable, changed);
    assert.throws(() => run(['--revert', '--archive', archive, '--exe', executable, '--confirm-workbuddy-closed']), /unknown target contents/);
    assert.equal(fs.readFileSync(executable)[0], changed[0]);
    fs.writeFileSync(executable, valid);
    run(['--revert', '--archive', archive, '--exe', executable, '--confirm-workbuddy-closed']);
    assert.equal(hash(archive), EXPECTED.archiveSha256);
    assert.equal(hash(executable), EXPECTED.executableSha256);
  } finally {
    console.log = output;
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('wb-patch-cycle-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
