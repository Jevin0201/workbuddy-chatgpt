import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { configPath, parseAlias, syncModels } from './workbuddy.js';

export async function migrateModels(target = configPath()) {
  let document;
  try { document = JSON.parse(await readFile(target, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const entries = Array.isArray(document) ? document : document.models;
  if (!Array.isArray(entries)) throw new Error('Unsupported models configuration');
  const current = entries.filter(item => item.openaiSubscription === true && item.url === 'http://127.0.0.1:43187/v1/chat/completions' && parseAlias(item.id));
  if (!current.length) return;
  const models = current.map(item => ({ id: parseAlias(item.id).id, name: item.name,
    reasoning: { efforts: (item.reasoning?.supportedEfforts ?? []).map(id => ({ id })), defaultEffort: item.reasoning?.defaultEffort },
    contextWindow: item.maxInputTokens, maxTokens: item.maxOutputTokens }));
  await syncModels({ selections: current.map(item => ({ id: parseAlias(item.id).id, enabled: !item.disabled })), catalog: { models }, token: current[0].apiKey, port: 43187, target });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await migrateModels();
