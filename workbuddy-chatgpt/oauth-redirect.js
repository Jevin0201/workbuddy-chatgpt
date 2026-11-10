import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const AUTHORIZE = 'https://auth.openai.com/api/accounts/authorize';
const TOKEN = 'https://auth.openai.com/api/accounts/oauth/token';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const random = () => randomBytes(32).toString('base64url');
const equal = (a, b) => {
  if (typeof a !== 'string') return false;
  const supplied = Buffer.from(a), expected = Buffer.from(b);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
};
function reply(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', Connection: 'close' });
  res.end(message);
}
function redirect(res, target) {
  res.writeHead(303, { Location: target, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', Connection: 'close' }); res.end();
}
const stageError = code => Object.assign(new Error(code), { code });
const NETWORK_CODES = new Set(['OPENAI_NETWORK_TIMEOUT', 'OPENAI_NETWORK_FAILED', 'transport_upstream_error']);
async function tokenJSON(response) {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const status = Number.isInteger(response.status) && response.status >= 400 && response.status <= 599 ? String(response.status) : 'FAILED';
    throw stageError(`AUTH_TOKEN_HTTP_${status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw stageError('AUTH_GRANT_SCHEMA');
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 1024 * 1024) throw stageError('AUTH_GRANT_SCHEMA');
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw stageError('AUTH_GRANT_SCHEMA'); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function normalizeGrant(token, clientId, previous) {
  if (!token || typeof token !== 'object' || Array.isArray(token) ||
      ![token.access_token, token.refresh_token, ...(previous ? [] : [token.id_token])].every(value => typeof value === 'string' && value.trim()) ||
      !Number.isFinite(token.expires_in) || token.expires_in <= 0 || !Number.isFinite(Date.now() + token.expires_in * 1000)) throw stageError('AUTH_GRANT_SCHEMA');
  const scopes = token.scope === undefined && previous ? previous.scopes :
    typeof token.scope === 'string' ? token.scope.trim().split(/\s+/) : [];
  if (!Array.isArray(scopes) || !scopes.includes('chatgpt.tokens.use.direct')) throw stageError('AUTH_SCOPE_MISSING');
  return { ...previous, type: 'oauth', access: token.access_token, refresh: token.refresh_token, clientId, scopes, expires: Date.now() + token.expires_in * 1000 - 180000 };
}
async function exchange(fetchImpl, body, signal) {
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000);
  try {
    const response = await fetchImpl(TOKEN, {
      method: 'POST', redirect: 'error', signal: deadline,
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    return await tokenJSON(response);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (NETWORK_CODES.has(error?.code) || /^AUTH_TOKEN_HTTP_(?:[45]\d{2}|FAILED)$/.test(error?.code) || error?.code === 'AUTH_GRANT_SCHEMA') throw error;
    throw stageError(deadline.aborted ? 'OPENAI_NETWORK_TIMEOUT' : 'OPENAI_NETWORK_FAILED');
  }
}

export function createRedirectOAuth({ refresh, returnUrl = 'http://127.0.0.1:51380/?auth_return=1', callbackPort = 1455, fetchImpl = globalThis.fetch } = {}) {
  const destination = new URL(returnUrl);
  if (destination.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(destination.hostname) || destination.username || destination.password || destination.pathname !== '/' || destination.hash || [...destination.searchParams].some(([key, value]) => key !== 'auth_return' || value !== '1')) throw new Error('Invalid fixed OAuth return destination');
  if (!Number.isInteger(callbackPort) || callbackPort < 0 || callbackPort > 65535 || typeof fetchImpl !== 'function' || (refresh !== undefined && typeof refresh !== 'function')) throw new Error('Invalid OAuth configuration');
  return {
    async refresh(credential, signal) {
      signal?.throwIfAborted();
      const token = await exchange(fetchImpl, { grant_type: 'refresh_token', client_id: credential.clientId, refresh_token: credential.refresh, resource: RESOURCE }, signal);
      signal?.throwIfAborted();
      return normalizeGrant(token, credential.clientId, credential);
    },
    async login(interaction, options) {
      const deviceId = options?.getDeviceId?.();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId || '')) throw new Error('Missing installation identity');
      const signal = interaction.signal;
      signal.throwIfAborted();
      const verifier = random(), state = random(), nonce = random();
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      let resolveResult, rejectResult, processing = false, settled = false;
      const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
      // A cancellation can win before the login starts awaiting the callback.
      result.catch(() => {});
      let redirectUri;
      const server = createServer(async (req, res) => {
        if (req.method !== 'GET') { reply(res, 405, '请使用浏览器完成登录回调。'); return; }
        const port = server.address()?.port;
        if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) { reply(res, 403, '回调地址校验失败。'); return; }
        if (String(req.url).length > 32768) { reply(res, 414, '回调地址过长。'); return; }
        let callback;
        try { callback = new URL(req.url, redirectUri); }
        catch { reply(res, 400, '回调地址格式错误。'); return; }
        if (callback.origin !== new URL(redirectUri).origin) { reply(res, 400, '回调来源校验失败。'); return; }
        if (callback.pathname !== '/auth/callback') { reply(res, 404, '回调地址不存在。'); return; }
        if (!equal(callback.searchParams.get('state'), state)) { reply(res, 400, '登录状态不匹配，请使用本次登录页面重试。'); return; }
        if (settled || processing) { reply(res, 409, '此登录回调已处理，请返回模型页面。'); return; }
        if (callback.searchParams.has('error')) {
          settled = true;
          redirect(res, destination.href);
          const error = new Error('OpenAI authorization was declined'); error.code = 'AUTH_DENIED'; rejectResult(error); return;
        }
        const code = callback.searchParams.get('code'), clientId = callback.searchParams.get('client_id');
        if (!code || code.length > 8192 || !clientId || !/^[a-zA-Z0-9._:-]{1,256}$/.test(clientId) || clientId === 'dynamic_agent_client') { reply(res, 400, '登录回调信息不完整，请重新授权。'); return; }
        processing = true;
        try {
          signal.throwIfAborted();
          interaction.notify({ type: 'progress', message: '正在完成账号授权' });
          const token = await exchange(fetchImpl, { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE }, signal);
          signal.throwIfAborted();
          const payload = normalizeGrant(token, clientId);
          settled = true;
          // The return page polls the committed account state; no credential enters the URL.
          redirect(res, destination.href); resolveResult(payload);
        } catch (error) {
          settled = true;
          if (!res.headersSent && !res.destroyed) redirect(res, destination.href);
          rejectResult(signal.aborted ? signal.reason : error);
        }
      });
      server.headersTimeout = 15000; server.requestTimeout = 60000;
      const abort = () => {
        settled = true; rejectResult(signal.reason || new Error('Login cancelled'));
        server.closeAllConnections(); server.close();
      };
      try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(callbackPort, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
        server.on('error', rejectResult);
        redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        signal.throwIfAborted();
        const url = new URL(AUTHORIZE);
        url.search = new URLSearchParams({ client_id: 'dynamic_agent_client', agent_name_hint: options?.agentName || 'WorkBuddy OpenAI Bridge', ext_agent_host_id: `urn:uuid:${deviceId.toLowerCase()}`, response_type: 'code', redirect_uri: redirectUri, resource: RESOURCE, scope: SCOPE, state, nonce, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
        interaction.notify({ type: 'auth_url', url: url.href });
        return await result;
      } finally {
        signal.removeEventListener('abort', abort);
        server.close(); server.closeIdleConnections();
      }
    },
  };
}
