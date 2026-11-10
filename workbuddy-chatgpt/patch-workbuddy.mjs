import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const EXPECTED = Object.freeze({
  version: '5.9.3',
  archiveSha256: 'dcabcd90f07a627a06f1fd55bc872a1c25a79aab43c3012930b6287840ab3d20',
  executableSha256: 'bbf504003825e0e22dd8c401b396d79db78ec603558088565d1b2e81561704a0',
  headerSha256: 'be04ffdf4dd936c4ccfc58a0027f73842056998b6c9ba8dd50bbfc9b65df8681',
  member: 'renderer/assets/ModelsSettingsPanel-DT-IyYEu.js',
  memberSha256: 'b1243a798bfe43cabea41d70014c270307ff515e8dbca9a6f61f623344b96497',
  url: 'http://127.0.0.1:43187/?from=workbuddy&autostart=1',
});
export const DEFAULT_ARCHIVE = 'C:\\Program Files\\WorkBuddy\\resources\\app.asar';
const MARKER = 'workbuddy-chatgpt-login';
const ANCHOR = 'className:`models-settings-panel__card-right`,children:R?';
const CLOSE = '})})})]}),te?';
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

export function parseAsar(bytes) {
  if (bytes.length < 16 || bytes.readUInt32LE(0) !== 4) throw Error('Invalid ASAR size pickle');
  const headerSize = bytes.readUInt32LE(4);
  const stringSize = bytes.readUInt32LE(12);
  if (headerSize + 8 > bytes.length || stringSize > headerSize - 8) throw Error('Invalid ASAR header bounds');
  return { header: JSON.parse(bytes.subarray(16, 16 + stringSize).toString('utf8')), payloadStart: headerSize + 8 };
}
function member(header, name) {
  let value = header;
  for (const part of name.split('/')) value = value?.files?.[part];
  if (!value || value.files || value.link || value.unpacked) throw Error(`Expected packed regular member: ${name}`);
  return value;
}
function entries(header, prefix = '') {
  return Object.entries(header.files ?? {}).flatMap(([name, entry]) => {
    const key = prefix + name;
    return entry.files ? entries(entry, key + '/') : [[key, entry]];
  });
}
function memberBytes(bytes, archive, name) {
  const entry = member(archive.header, name);
  const start = archive.payloadStart + Number(entry.offset);
  if (!Number.isSafeInteger(start) || start < archive.payloadStart || start + entry.size > bytes.length) {
    throw Error(`Invalid member bounds: ${name}`);
  }
  return bytes.subarray(start, start + entry.size);
}
function encodeHeader(header) {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const picklePayloadSize = (4 + json.length + 3) & ~3;
  const result = Buffer.alloc(8 + 4 + picklePayloadSize);
  result.writeUInt32LE(4, 0);
  result.writeUInt32LE(4 + picklePayloadSize, 4);
  result.writeUInt32LE(picklePayloadSize, 8);
  result.writeUInt32LE(json.length, 12);
  json.copy(result, 16);
  return result;
}
function integrity(bytes, blockSize) {
  if (!Number.isSafeInteger(blockSize) || blockSize < 1) throw Error('Invalid integrity block size');
  const blocks = [];
  for (let offset = 0; offset < bytes.length; offset += blockSize) blocks.push(sha256(bytes.subarray(offset, offset + blockSize)));
  return { algorithm: 'SHA256', hash: sha256(bytes), blockSize, blocks };
}
export function transformSource(source) {
  if (source.includes(MARKER)) throw Error('Bridge button already present');
  if (source.split(ANCHOR).length !== 2) throw Error('Model action anchor is ambiguous or missing');
  const start = source.indexOf(ANCHOR);
  const end = source.indexOf(CLOSE, start);
  if (end < start || end - start > 1500) throw Error('Model action closing anchor changed');
  // Keep the existing enterprise-policy-aware Add button intact as the second child.
  const button = '(0,Q.jsx)(k,{variant:`secondary`,size:`medium`,className:`models-settings-panel__add-button`,"data-workbuddy-chatgpt":`' + MARKER + '`,onClick:()=>$(' + JSON.stringify(EXPECTED.url) + '),children:`登录ChatGPT`}),';
  return source.slice(0, start) + source.slice(start, end).replace(ANCHOR, ANCHOR.replace('children:R?', 'children:[') + button + 'R?') + '})})]})]}),te?' + source.slice(end + CLOSE.length);
}
export const DISPLAY_MEMBER = 'renderer/assets/contexts-Cfdc2AZw.js';
export function transformModelDisplay(source) {
  const anchor = 'function getModelDisplayName(e,t){';
  if (source.split(anchor).length !== 2) throw Error('Model display anchor changed');
  return source.replace(anchor, anchor + 'if(/^(?:custom-local:)?openai:/.test(e.id))return(e.name||e.id).replace(/^(GPT-\\d+(?:\\.\\d+)?)-(Sol|Astra|Terra|Luna)$/i,`$1 $2`);');
}
export function buildPatchedArchive(original) {
  if (sha256(original) !== EXPECTED.archiveSha256) throw Error('Archive SHA-256 differs from reviewed WorkBuddy build');
  const parsed = parseAsar(original);
  const pkg = JSON.parse(memberBytes(original, parsed, 'package.json').toString('utf8'));
  if (pkg.version !== EXPECTED.version) throw Error(`Unexpected WorkBuddy version: ${pkg.version}`);
  const sourceBytes = memberBytes(original, parsed, EXPECTED.member);
  if (sha256(sourceBytes) !== EXPECTED.memberSha256) throw Error('Model renderer SHA-256 differs from reviewed member');
  const replacement = Buffer.from(transformSource(sourceBytes.toString('utf8')), 'utf8');
  const header = structuredClone(parsed.header);
  const target = member(header, EXPECTED.member);
  // ASAR offsets are relative to the payload, so appending preserves every other offset.
  target.offset = String(original.length - parsed.payloadStart);
  target.size = replacement.length;
  target.integrity = integrity(replacement, target.integrity?.blockSize ?? 4194304);
  const displayBytes = memberBytes(original, parsed, DISPLAY_MEMBER);
  if (sha256(displayBytes) !== '77f7314eea73165cf4f9a8f86430a76c3a7bd6822b3d134bc2946d75f9911851') throw Error('Model display renderer changed');
  const displayReplacement = Buffer.from(transformModelDisplay(displayBytes.toString('utf8')), 'utf8');
  const displayTarget = member(header, DISPLAY_MEMBER);
  displayTarget.offset = String(original.length - parsed.payloadStart + replacement.length);
  displayTarget.size = displayReplacement.length;
  displayTarget.integrity = integrity(displayReplacement, displayTarget.integrity?.blockSize ?? 4194304);
  const patched = Buffer.concat([encodeHeader(header), original.subarray(parsed.payloadStart), replacement, displayReplacement]);
  const check = parseAsar(patched);
  let unchangedPackedMembers = 0;
  for (const [name, entry] of entries(parsed.header)) {
    if (name === EXPECTED.member || name === DISPLAY_MEMBER || entry.unpacked || entry.link) continue;
    if (!memberBytes(original, parsed, name).equals(memberBytes(patched, check, name))) throw Error(`Unexpected change: ${name}`);
    unchangedPackedMembers++;
  }
  if (!memberBytes(patched, check, EXPECTED.member).equals(replacement)) throw Error('Replacement member verification failed');
  const actual = member(check.header, EXPECTED.member).integrity;
  if (JSON.stringify(actual) !== JSON.stringify(integrity(replacement, actual.blockSize))) throw Error('Replacement integrity verification failed');
  return { patched, replacement, report: {
    version: pkg.version, originalSha256: sha256(original), patchedSha256: sha256(patched),
    member: EXPECTED.member, originalMemberSha256: sha256(sourceBytes), patchedMemberSha256: sha256(replacement),
    unchangedPackedMembers, originalBytes: original.length, patchedBytes: patched.length,
    url: EXPECTED.url, companionPolicy: 'app.asar.unpacked unchanged',
  } };
}
export function headerSha256(archive) {
  parseAsar(archive);
  return sha256(archive.subarray(16, 16 + archive.readUInt32LE(12)));
}
export function buildPatchedExecutable(original, originalArchive, patchedArchive) {
  if (sha256(original) !== EXPECTED.executableSha256) throw Error('Executable SHA-256 differs from reviewed WorkBuddy build');
  if (sha256(originalArchive) !== EXPECTED.archiveSha256 || headerSha256(originalArchive) !== EXPECTED.headerSha256) throw Error('Original archive/header identity mismatch');
  const nextHash = headerSha256(patchedArchive);
  const patched = Buffer.from(original);
  const resources = [
    { name: 'INTEGRITY/ELECTRONASAR/1033', offset: 203414128, size: 251, sha256: '9aab3b289a73c2ae600f78de992e46b2f56565e15f00ff84f9407eb667e68a68' },
    { name: 'Integrity/ElectronAsar/0', offset: 203414384, size: 122, sha256: 'b49d4cfe18d454421a77cb9a0186d617e93b278e8b8120ced16345b42dfa65be' },
  ];
  const ranges = [];
  for (const resource of resources) {
    const payload = original.subarray(resource.offset, resource.offset + resource.size);
    if (sha256(payload) !== resource.sha256) throw Error(`PE resource digest changed: ${resource.name}`);
    const source = payload.toString('utf8');
    const records = JSON.parse(source);
    const app = records.filter(record => record.file === 'resources\\app.asar');
    if (app.length !== 1 || app[0].value !== EXPECTED.headerSha256 || app[0].alg.toLowerCase() !== 'sha256') throw Error('Unexpected embedded archive integrity record');
    const relative = source.indexOf(EXPECTED.headerSha256);
    if (relative < 0 || source.lastIndexOf(EXPECTED.headerSha256) !== relative) throw Error('Embedded hash location is ambiguous');
    const offset = resource.offset + relative;
    patched.write(nextHash, offset, 64, 'ascii');
    ranges.push({ resource: resource.name, offset, size: 64 });
    const actualRecords = JSON.parse(patched.subarray(resource.offset, resource.offset + resource.size).toString('utf8'));
    for (let index = 0; index < records.length; index++) {
      const expectedRecord = records[index].file === 'resources\\app.asar' ? { ...records[index], value: nextHash } : records[index];
      if (JSON.stringify(actualRecords[index]) !== JSON.stringify(expectedRecord)) throw Error('Unexpected embedded resource mutation');
    }
  }
  let last = 0;
  for (const range of ranges) {
    if (!original.subarray(last, range.offset).equals(patched.subarray(last, range.offset))) throw Error('Unexpected executable modification');
    last = range.offset + range.size;
  }
  if (!original.subarray(last).equals(patched.subarray(last))) throw Error('Unexpected executable tail modification');
  return { patched, report: {
    originalExecutableSha256: sha256(original), patchedExecutableSha256: sha256(patched),
    originalHeaderSha256: EXPECTED.headerSha256, patchedHeaderSha256: nextHash, executableChangedRanges: ranges,
    fusesUnchanged: true, defaultAppIntegrityUnchanged: true,
    authenticodeEffect: 'Tencent signature becomes HashMismatch; full original restored on revert',
  } };
}
export function inspectIntegrityFuse(executable) {
  if (!fs.existsSync(executable)) return { executable, state: 'executable-absent' };
  const bytes = fs.readFileSync(executable);
  const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  const offset = bytes.indexOf(sentinel);
  const position = offset + sentinel.length;
  if (offset < 0 || bytes[position] !== 1 || bytes[position + 1] < 6) return { executable, state: 'unknown' };
  const enabled = bytes[position + 2 + 4];
  return { executable, state: enabled === 49 ? 'enabled' : enabled === 48 ? 'disabled' : 'unknown', sentinelOffset: offset };
}
function verifiedCopy(file, expectedHash) {
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== expectedHash) throw Error(`File hash verification failed: ${file}`);
  return bytes;
}
export function replacePair(items, io = fs) {
  const changed = [];
  const staged = [];
  try {
    for (const item of items) {
      const target = path.resolve(item.target);
      if (target !== item.target) throw Error('Replacement target must be absolute');
      verifiedCopy(target, item.beforeHash);
      if (io.existsSync(item.temporary)) throw Error(`Pending file already exists: ${item.temporary}`);
      io.writeFileSync(item.temporary, item.after, { flag: 'wx' });
      staged.push(item);
      verifiedCopy(item.temporary, item.afterHash);
    }
    for (const item of items) {
      verifiedCopy(item.target, item.beforeHash);
      io.renameSync(item.temporary, item.target);
      changed.push(item);
      verifiedCopy(item.target, item.afterHash);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of changed.reverse()) {
      try {
        verifiedCopy(item.target, item.afterHash);
        const recovery = item.temporary + '.rollback';
        io.writeFileSync(recovery, item.before, { flag: 'wx' });
        verifiedCopy(recovery, item.beforeHash);
        io.renameSync(recovery, item.target);
        verifiedCopy(item.target, item.beforeHash);
      } catch (rollbackError) { rollbackErrors.push(`${item.target}: ${rollbackError.message}`); }
    }
    throw Error(`${error.message}; rollback=${rollbackErrors.length ? rollbackErrors.join(' | ') : 'completed'}`, { cause: error });
  } finally {
    for (const item of staged) {
      if (io.existsSync(item.temporary)) {
        // Remove only this operation's exact staged artifact, never an unknown file.
        verifiedCopy(item.temporary, item.afterHash);
        io.unlinkSync(item.temporary);
      }
    }
  }
}
export function run(argv = process.argv.slice(2)) {
  const known = new Set(['--dry-run', '--apply', '--revert', '--archive', '--exe', '--confirm-workbuddy-closed', '--accept-signature-change']);
  let archive = DEFAULT_ARCHIVE;
  let executable;
  const flags = new Set();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!known.has(arg)) throw Error(`Unknown argument: ${arg}`);
    if (arg === '--archive' || arg === '--exe') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw Error(`${arg} requires an explicit file path`);
      if (arg === '--archive') archive = value; else executable = value;
    } else flags.add(arg);
  }
  const operations = ['--dry-run', '--apply', '--revert'].filter(flag => flags.has(flag));
  if (operations.length > 1) throw Error('Select exactly one operation');
  const operation = operations[0] ?? '--dry-run';
  archive = path.resolve(archive);
  executable = path.resolve(executable ?? path.resolve(path.dirname(archive), '..', 'WorkBuddy.exe'));
  if (path.basename(archive).toLowerCase() !== 'app.asar' || path.basename(executable).toLowerCase() !== 'workbuddy.exe') throw Error('Expected app.asar and WorkBuddy.exe target filenames');
  const suffix = '.workbuddy-chatgpt-5.9.3.original';
  const backup = archive + suffix;
  const executableBackup = executable + suffix;
  const receipt = archive + '.workbuddy-chatgpt-5.9.3.json';
  if (operation !== '--dry-run' && !flags.has('--confirm-workbuddy-closed')) throw Error('Exit WorkBuddy, then pass --confirm-workbuddy-closed');
  if (operation === '--apply' && !flags.has('--accept-signature-change')) throw Error('Tencent Authenticode will become HashMismatch; pass --accept-signature-change after explicit user confirmation');
  if (operation === '--revert') {
    const record = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    if (record.archive !== archive || record.executable !== executable || record.originalSha256 !== EXPECTED.archiveSha256 || record.originalExecutableSha256 !== EXPECTED.executableSha256) throw Error('Backup receipt identity mismatch');
    const originals = [verifiedCopy(backup, EXPECTED.archiveSha256), verifiedCopy(executableBackup, EXPECTED.executableSha256)];
    const definitions = [
      { target: archive, originalHash: EXPECTED.archiveSha256, patchedHash: record.patchedSha256, original: originals[0] },
      { target: executable, originalHash: EXPECTED.executableSha256, patchedHash: record.patchedExecutableSha256, original: originals[1] },
    ];
    const items = definitions.map(item => {
      const before = fs.readFileSync(item.target);
      const beforeHash = sha256(before);
      if (![item.originalHash, item.patchedHash].includes(beforeHash)) throw Error(`Revert blocked by unknown target contents: ${item.target}`);
      return { target: item.target, before, beforeHash, after: item.original, afterHash: item.originalHash, temporary: item.target + '.workbuddy-chatgpt.pending' };
    }).filter(item => item.beforeHash !== item.afterHash);
    replacePair(items);
    console.log(JSON.stringify({ operation: 'revert', archive, executable, originalArchiveRestored: true, originalExecutableRestored: true, backupsRetained: [backup, executableBackup] }, null, 2));
    return;
  }
  const original = fs.readFileSync(archive);
  const originalExecutable = fs.readFileSync(executable);
  const { patched, report } = buildPatchedArchive(original);
  const exeResult = buildPatchedExecutable(originalExecutable, original, patched);
  Object.assign(report, exeResult.report, { embeddedIntegrityFuse: inspectIntegrityFuse(executable), installationCompatibility: 'metadata-consistent-runtime-unverified' });
  if (operation === '--apply') {
    for (const [target, file, hash] of [[archive, backup, EXPECTED.archiveSha256], [executable, executableBackup, EXPECTED.executableSha256]]) {
      verifiedCopy(target, hash);
      if (fs.existsSync(file)) verifiedCopy(file, hash);
      else fs.copyFileSync(target, file, fs.constants.COPYFILE_EXCL);
      verifiedCopy(file, hash);
    }
    const record = { archive, executable, backup, executableBackup, ...report };
    if (fs.existsSync(receipt)) {
      const previous = JSON.parse(fs.readFileSync(receipt, 'utf8'));
      if (previous.archive !== archive || previous.executable !== executable || previous.patchedSha256 !== report.patchedSha256 || previous.patchedExecutableSha256 !== report.patchedExecutableSha256) throw Error('Existing receipt conflicts with this patch');
    } else fs.writeFileSync(receipt, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    replacePair([
      { target: archive, before: original, beforeHash: EXPECTED.archiveSha256, after: patched, afterHash: report.patchedSha256, temporary: archive + '.workbuddy-chatgpt.pending' },
      { target: executable, before: originalExecutable, beforeHash: EXPECTED.executableSha256, after: exeResult.patched, afterHash: report.patchedExecutableSha256, temporary: executable + '.workbuddy-chatgpt.pending' },
    ]);
  }
  console.log(JSON.stringify({ operation: operation.slice(2), archive, executable, backup, executableBackup, receipt, ...report, installationModified: operation === '--apply' }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { run(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
