import { readFile, writeFile, copyFile, mkdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { BridgeError } from './errors.js';

export const configPath = () => join(process.env.WORKBUDDY_CONFIG_DIR || process.env.CODEBUDDY_CONFIG_DIR || join(homedir(), '.workbuddy'), 'models.json');
export const modelAlias = (id, effort = '') => `openai:${encodeURIComponent(id)}:${encodeURIComponent(effort || 'default')}`;
export function parseAlias(alias) {
  if (typeof alias !== 'string' || !alias.startsWith('openai:')) return undefined;
  const parts = alias.split(':');
  if (parts.length !== 3) throw new BridgeError('模型路由格式错误。');
  try { return { id: decodeURIComponent(parts[1]), effort: parts[2] === 'default' ? '' : decodeURIComponent(parts[2]) }; }
  catch { throw new BridgeError('模型路由编码错误。'); }
}
export function selectModel(catalog, id, effort = '') {
  const model = catalog.models.find(model => model.id === id);
  if (!model) throw new BridgeError('模型已不在账号实时目录中，请刷新模型列表。', 404, 'model_not_found');
  if (effort && !model.reasoning?.efforts.some(item => item.id === effort)) throw new BridgeError('该模型未公开所选推理档位，请刷新后重新选择。');
  return model;
}
export async function syncModels({ selections, catalog, token, port, target = configPath() }) {
  if (!Array.isArray(selections) || selections.length > 1000) throw new BridgeError('最多同步 1000 项。');
  const seen = new Set();
  const selected = selections.map(selection => {
    if (!selection || typeof selection.id !== 'string' || (selection.effort !== undefined && typeof selection.effort !== 'string')) throw new BridgeError('模型选择格式错误。');
    if (seen.has(selection.id)) throw new BridgeError('模型选择重复。');
    seen.add(selection.id);
    return { model: selectModel(catalog, selection.id, selection.effort), effort: '', enabled: selection.enabled !== false };
  });
  const endpoint = `http://127.0.0.1:${port}/v1/chat/completions`;
  let original;
  try { original = await readFile(target, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const document = original === undefined ? [] : JSON.parse(original);
  const models = Array.isArray(document) ? document : document?.models;
  if (!Array.isArray(models)) throw new BridgeError('WorkBuddy 配置结构发生变化，原内容已保留。', 409);
  const owned = model => [endpoint, 'http://127.0.0.1:51379/v1/chat/completions'].includes(model.url) && (model.openaiSubscription === true || model.dshBridge === true);
  const superseded = model => model.dshBridge === true && model.url === 'http://127.0.0.1:51380/v1/chat/completions' && catalog.models.some(current => current.id === model.id);
  const removed = models.filter(owned).map(model => model.id);
  const entries = selected.map(({ model, effort, enabled }) => ({
    id: modelAlias(model.id, effort),
    name: `${(model.name || model.id).replace(/^(GPT-\d+(?:\.\d+)?)-(Sol|Astra|Terra|Luna)$/i, '$1 $2')}${effort ? ` · ${model.reasoning.efforts.find(item => item.id === effort)?.name || effort}` : ''}`,
    vendor: 'custom', url: endpoint, apiKey: token,
    disabled: !enabled, supportsToolCall: true, supportsImages: false,
    supportsReasoning: (model.reasoning?.efforts.length ?? 0) > 0,
    reasoning: { supportedEfforts: model.reasoning?.efforts.map(item => item.id) ?? [], ...(model.reasoning?.defaultEffort ? { defaultEffort: model.reasoning.defaultEffort } : {}) },
    ...(model.contextWindow ? { maxInputTokens: model.contextWindow } : {}),
    ...(model.maxTokens ? { maxOutputTokens: model.maxTokens } : {}),
    openaiSubscription: true,
  }));
  for (const entry of entries) if (models.some(model => model.id === entry.id && !owned(model))) throw new BridgeError('存在同名的其他模型配置，请先调整其 ID。', 409);
  const nextModels = [...models.filter(model => !owned(model)).map(model => superseded(model) ? { ...model, disabled: true } : model), ...entries];
  const next = Array.isArray(document) ? nextModels : { ...document, models: nextModels };
  if (!Array.isArray(next) && Array.isArray(next.availableModels)) {
    const oldIds = new Set(removed.flatMap(id => [id, `custom-local:${id}`]));
    next.availableModels = [...new Set([...next.availableModels.filter(id => !oldIds.has(id)), ...entries.flatMap(model => [model.id, `custom-local:${model.id}`])])];
  }
  await mkdir(dirname(target), { recursive: true });
  const serialized = JSON.stringify(next, null, 2) + '\n';
  let backup;
  if (original === serialized) return { saved: true, count: entries.length, unchanged: true };
  if (original === undefined) await writeFile(target, serialized, { flag: 'wx', mode: 0o600 });
  else {
    backup = `${target}.openai-backup-${Date.now()}-${randomUUID().slice(0, 8)}`;
    await copyFile(target, backup, 1);
    const temporary = `${target}.openai-${randomUUID()}.tmp`;
    await writeFile(temporary, serialized, { flag: 'wx', mode: 0o600 });
    if (await readFile(target, 'utf8') !== original) throw new BridgeError('WorkBuddy 刚刚更新了配置，原内容已保留，请重试。', 409);
    // The fixed configuration target and temporary path are verified sibling files.
    await rename(temporary, target);
  }
  return { saved: true, count: entries.length, backup };
}
