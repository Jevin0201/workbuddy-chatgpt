import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseAsar, headerSha256, replacePair, transformModelDisplay, quotaWidgetBootstrap } from './patch-workbuddy.mjs';

export const PROFILE = {
  version: '5.11.3',
  archive: '42e3c7cf05a21e1ab491911fa386583956dab3ddf358ba7004d75dd559eba27f',
  executable: 'b5b065a19cc66f23855bd4f122283f799e290d58a5c13603e14e3442f415f733',
};
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function entry(header, name) { return name.split('/').reduce((value, part) => value.files[part], header); }
function content(bytes, parsed, name) {
  const item = entry(parsed.header, name);
  return bytes.subarray(parsed.payloadStart + Number(item.offset), parsed.payloadStart + Number(item.offset) + item.size);
}
function encode(header) {
  const json = Buffer.from(JSON.stringify(header));
  const payload = (4 + json.length + 3) & ~3;
  const result = Buffer.alloc(12 + payload);
  result.writeUInt32LE(4); result.writeUInt32LE(4 + payload, 4);
  result.writeUInt32LE(payload, 8); result.writeUInt32LE(json.length, 12); json.copy(result, 16);
  return result;
}
export function build(bytes, executable) {
  if (hash(bytes) !== PROFILE.archive || hash(executable) !== PROFILE.executable) throw Error('WorkBuddy 5.11.3 文件校验失败');
  const parsed = parseAsar(bytes), header = structuredClone(parsed.header);
  const common = 'renderer/assets/common-p2lSs_-n.js';
  const settings = 'renderer/assets/ModelsSettingsPanel-BlsTjREb.js';
  let source = transformModelDisplay(content(bytes, parsed, common).toString());
  const anchor = 'selectedId:Re,selectedIsThinking:He';
  if (source.split(anchor).length !== 2) throw Error('模型选择入口变化');
  source = source.replace(anchor, 'selectedId:(queueMicrotask(()=>window.dispatchEvent(new CustomEvent("workbuddy-chatgpt-model",{detail:Re}))),Re),selectedIsThinking:He');
  source += '\n;(' + quotaWidgetBootstrap.toString() + ')();';
  let settingsSource = content(bytes, parsed, settings).toString();
  // A DOM button uses the existing settings action group without changing its React structure.
  settingsSource += `\n;(()=>{const attach=()=>{const host=document.querySelector('.models-settings-panel__card-right');if(!host||host.querySelector('[data-chatgpt-login]'))return;const button=document.createElement('button');button.dataset.chatgptLogin='1';button.className='models-settings-panel__add-button';button.textContent='登录ChatGPT';button.onclick=()=>window.open('http://127.0.0.1:43187/','_blank');host.prepend(button);};const start=()=>{new MutationObserver(attach).observe(document.body,{childList:true,subtree:true});attach();};if(document.body)start();else document.addEventListener('DOMContentLoaded',start,{once:true});})();`;
  const replacements = [[common, Buffer.from(source)], [settings, Buffer.from(settingsSource)]];
  let offset = bytes.length - parsed.payloadStart;
  for (const [name, replacement] of replacements) {
    const item = entry(header, name), blockSize = item.integrity?.blockSize ?? 4194304;
    const blocks = [];
    for (let index = 0; index < replacement.length; index += blockSize) blocks.push(hash(replacement.subarray(index, index + blockSize)));
    item.offset = String(offset); item.size = replacement.length;
    item.integrity = { algorithm: 'SHA256', hash: hash(replacement), blockSize, blocks };
    offset += replacement.length;
  }
  const archive = Buffer.concat([encode(header), bytes.subarray(parsed.payloadStart), ...replacements.map(item => item[1])]);
  const check = parseAsar(archive);
  for (const [name, replacement] of replacements) if (!content(archive, check, name).equals(replacement)) throw Error('补丁验证失败');
  const patchedExe = Buffer.from(executable), needle = Buffer.from(headerSha256(bytes));
  let count = 0;
  for (let index = executable.indexOf(needle); index >= 0; index = executable.indexOf(needle, index + needle.length)) {
    patchedExe.write(headerSha256(archive), index, 64, 'ascii'); count++;
  }
  if (count !== 2) throw Error('安装文件完整性记录变化');
  return { archive, executable: patchedExe };
}
export function run(args = process.argv.slice(2)) {
  const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const archive = path.resolve(value('--archive') || 'C:/Program Files/WorkBuddy/resources/app.asar');
  const executable = path.resolve(value('--exe') || path.join(path.dirname(archive), '../WorkBuddy.exe'));
  const receipt = archive + '.workbuddy-chatgpt-5.11.3.json';
  const suffix = '.workbuddy-chatgpt-5.11.3.original';
  const restore = args.includes('--revert'), apply = args.includes('--apply');
  if ((restore || apply) && !args.includes('--confirm-workbuddy-closed')) throw Error('请先退出 WorkBuddy');
  if (apply && !args.includes('--accept-signature-change')) throw Error('需要确认安装文件签名变化');
  const before = [fs.readFileSync(archive), fs.readFileSync(executable)];
  let after;
  if (restore) {
    const record = JSON.parse(fs.readFileSync(receipt));
    if (record.archive !== archive || record.executable !== executable) throw Error('安装记录路径不匹配');
    if (![PROFILE.archive, record.patchedSha256].includes(hash(before[0])) || ![PROFILE.executable, record.patchedExecutableSha256].includes(hash(before[1]))) throw Error('未知文件修改，停止还原');
    after = [fs.readFileSync(archive + suffix), fs.readFileSync(executable + suffix)];
    if (hash(after[0]) !== PROFILE.archive || hash(after[1]) !== PROFILE.executable) throw Error('原件备份校验失败');
  } else {
    const result = build(...before); after = [result.archive, result.executable];
  }
  if (apply) {
    for (const [index, file] of [archive, executable].entries()) {
      if (!fs.existsSync(file + suffix)) fs.copyFileSync(file, file + suffix, fs.constants.COPYFILE_EXCL);
      if (hash(fs.readFileSync(file + suffix)) !== hash(before[index])) throw Error('备份冲突');
    }
    const record = { archive, executable, version: PROFILE.version, originalSha256: PROFILE.archive, originalExecutableSha256: PROFILE.executable, patchedSha256: hash(after[0]), patchedExecutableSha256: hash(after[1]) };
    if (fs.existsSync(receipt) && fs.readFileSync(receipt, 'utf8') !== JSON.stringify(record)) throw Error('安装记录冲突');
    fs.writeFileSync(receipt, JSON.stringify(record));
  }
  if (apply || restore) replacePair([archive, executable].map((target, index) => ({ target, before: before[index], beforeHash: hash(before[index]), after: after[index], afterHash: hash(after[index]), temporary: target + '.chatgpt.pending' })));
  console.log(JSON.stringify({ version: PROFILE.version, operation: restore ? 'revert' : apply ? 'apply' : 'dry-run', patchedSha256: hash(after[0]) }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { run(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
