import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { ProxyAgent, fetch } from 'undici';
import { createCredentialStore } from './credentials.js';
import { createAccountAuth } from './auth-account.js';
import { createRedirectOAuth } from './oauth-redirect.js';
import { createScopedTransport } from './transport.js';
import { createCurlTokenFetch } from './curl-token.js';
import { createOfficialApi } from './official-api.js';
import { createEngine } from './engine.js';
import { createServerBridge } from './server.js';

export async function startService({ directory = join(process.env.LOCALAPPDATA, 'WorkBuddyChatGPT'), proxyUrl = '', port = 43187 } = {}) {
  await mkdir(directory, { recursive: true });
  const keyFile = join(directory, 'bridge.key');
  let token;
  try { token = (await readFile(keyFile, 'utf8')).trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; token = randomBytes(32).toString('hex'); await writeFile(keyFile, token, { flag: 'wx', mode: 0o600 }); }
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local key');
  const transport = createScopedTransport({ proxyUrl, ProxyAgent, fetchImpl: fetch, tokenFetchImpl: proxyUrl ? createCurlTokenFetch({ proxyUrl }) : undefined });
  const oauth = createRedirectOAuth({ fetchImpl: transport.fetch, returnUrl: `http://127.0.0.1:${port}/?auth_return=1` });
  const auth = createAccountAuth({ credentials: createCredentialStore(directory) }, { oauth });
  const api = createOfficialApi({ auth, fetchImpl: transport.fetch });
  const bridge = createServerBridge({ auth, api, engine: createEngine({ api }), token, port });
  try { bridge.server.listen(port, '127.0.0.1'); await once(bridge.server, 'listening'); }
  catch (error) { await bridge.close(); await auth.close(); await transport.close(); throw error; }
  return { port: bridge.server.address().port, async close() { await bridge.close(); await auth.close(); await transport.close(); } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const configFile = join(dirname(fileURLToPath(import.meta.url)), 'settings.json');
  const config = JSON.parse(await readFile(configFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error; }));
  const service = await startService(config);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => service.close().then(() => process.exit()));
}
