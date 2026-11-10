import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { BridgeError } from './errors.js';
import { CompletionState, finishReason, openAIUsage } from './completion.js';
import { modelAlias, syncModels, configPath, parseAlias } from './workbuddy.js';
import { readFile } from 'node:fs/promises';
import { PROVIDER } from './engine.js';
import { page } from './page.js';

const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
const errorBody = error => ({ error: { code: error instanceof BridgeError ? error.code : 'internal_error', message: error instanceof BridgeError ? error.message : '请求未完成，请检查本机服务或重新登录。' } });
async function readBody(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new BridgeError('请求需使用 JSON 格式。', 415);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) throw new BridgeError('请求内容超过 4 MiB。', 413); chunks.push(chunk); }
  try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error(); return body; }
  catch { throw new BridgeError('请求 JSON 格式错误。'); }
}
async function send(res, value) {
  if (res.destroyed) throw new Error('Client disconnected');
  if (!res.write(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`)) {
    await new Promise((resolve, reject) => {
      const cleanup = () => { res.off('drain', drained); res.off('close', failed); res.off('error', failed); };
      const drained = () => { cleanup(); resolve(); }; const failed = () => { cleanup(); reject(new Error('Client disconnected')); };
      res.once('drain', drained); res.once('close', failed); res.once('error', failed); if (res.destroyed) failed();
    });
  }
}
export function createServerBridge({ ctx, auth, api, engine, token, port = 51380, workbuddyTarget }) {
  const sessions = new Map(), active = new Set();
  let syncTail = Promise.resolve();
  function establishSession(res, actualPort) {
    for (const [key, expiry] of sessions) if (expiry <= Date.now()) sessions.delete(key);
    if (sessions.size >= 32) sessions.delete(sessions.keys().next().value);
    const cookie = randomBytes(32).toString('hex'); sessions.set(cookie, Date.now() + 7200000);
    res.setHeader('Set-Cookie', `wb_openai_${actualPort}=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=7200`);
  }
  const server = createServer(async function workbuddyOpenAIHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const controller = new AbortController(); const abort = () => controller.abort();
    req.once('aborted', abort); res.once('close', abort); active.add(controller);
    try {
      if (active.size > 16) throw new BridgeError('当前请求较多，请稍后重试。', 429);
      const actualPort = server.address()?.port ?? port;
      if (![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(req.headers.host)) throw new BridgeError('本机地址校验失败。', 403);
      const origin = `http://${req.headers.host}`, url = new URL(req.url, origin), path = url.pathname;
      if (req.headers.origin !== undefined && req.headers.origin !== origin) throw new BridgeError('跨站请求已拦截。', 403);
      if (req.method === 'GET' && (path === '/' || path === '/login')) {
        const status = await auth.status();
        const autoLogin = url.searchParams.get('autostart') === '1' && url.searchParams.get('auth_return') !== '1' && !status.configured;
        if (path === '/login' || autoLogin) {
          if (req.headers['sec-fetch-dest'] && req.headers['sec-fetch-dest'] !== 'document') throw new BridgeError('请通过浏览器页面开始授权。', 403);
          if (status.state !== 'running') await auth.start();
          const target = new URL(await auth.authorizationUrl({ signal: controller.signal }));
          if (target.origin !== 'https://auth.openai.com' || target.pathname !== '/api/accounts/authorize' || target.username || target.password || target.hash) throw new BridgeError('授权地址校验失败。', 502);
          establishSession(res, actualPort);
          res.writeHead(303, { Location: target.href }); res.end(); return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page); return;
      }
      if (req.method === 'GET' && path === '/health') { json(res, 200, { service: 'workbuddy-openai', version: '0.4.2' }); return; }
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new BridgeError('跨站请求已拦截。', 403);
      const cookieName = `wb_openai_${actualPort}`;
      if (req.method === 'POST' && path === '/bridge/connect') {
        if (req.headers.origin !== origin || req.headers['x-bridge-desktop'] !== '1') throw new BridgeError('请从本机页面建立连接。', 403);
        await readBody(req);
        establishSession(res, actualPort);
        json(res, 200, { connected: true }); return;
      }
      const supplied = Buffer.from(String(req.headers.authorization || '')), expected = Buffer.from(`Bearer ${token}`);
      const bearer = supplied.length === expected.length && timingSafeEqual(supplied, expected);
      const cookie = String(req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
      const management = path.startsWith('/bridge/') || path.startsWith('/auth/') || path === '/workbuddy/sync';
      if (!bearer && !(management && cookie && (sessions.get(cookie) ?? 0) > Date.now())) throw new BridgeError('本地连接已过期，请刷新页面重新连接。', 401, 'authentication_required');
      if (req.method === 'GET' && path === '/auth/status') { json(res, 200, await auth.status()); return; }
      if (req.method === 'GET' && path === '/bridge/preferences') {
        let document;
        try { document = JSON.parse(await readFile(workbuddyTarget || configPath(), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const entries = Array.isArray(document) ? document : document?.models ?? [];
        const models = entries.filter(item => item.openaiSubscription && item.url === `http://127.0.0.1:${actualPort}/v1/chat/completions`).map(item => ({ id: parseAlias(item.id)?.id, enabled: !item.disabled })).filter(item => item.id);
        json(res, 200, { models }); return;
      }
      if (req.method === 'POST' && path === '/auth/start') { await readBody(req); json(res, 200, await auth.start()); return; }
      if (req.method === 'POST' && path === '/auth/answer') { json(res, 200, await auth.answer(await readBody(req))); return; }
      if (req.method === 'POST' && path === '/auth/cancel') { await readBody(req); json(res, 200, await auth.cancel()); return; }
      if (req.method === 'GET' && path === '/bridge/models') {
        const catalog = await api.models({ force: url.searchParams.get('refresh') === '1', signal: controller.signal });
        ctx?.emit?.('llm/models-updated', PROVIDER); json(res, 200, catalog); return;
      }
      if (req.method === 'GET' && path === '/bridge/usage') { json(res, 200, await api.usage({ force: url.searchParams.get('refresh') === '1', signal: controller.signal })); return; }
      if (req.method === 'POST' && path === '/workbuddy/sync') {
        const body = await readBody(req), catalog = await api.models({ signal: controller.signal });
        const run = () => syncModels({ selections: body.models, catalog, token, port: actualPort, target: workbuddyTarget });
        const operation = syncTail.then(run, run); syncTail = operation.catch(() => {}); json(res, 200, await operation); return;
      }
      if (req.method === 'GET' && path === '/v1/models') {
        const catalog = await api.models({ signal: controller.signal });
        json(res, 200, { object: 'list', data: catalog.models.map(model => ({ id: modelAlias(model.id), object: 'model', name: model.name, owned_by: 'openai', created: 0 })) }); return;
      }
      if (req.method !== 'POST' || path !== '/v1/chat/completions') throw new BridgeError('接口地址不存在。', 404);
      const body = await readBody(req), prepared = await engine.prepare(body, controller.signal), state = new CompletionState(body.model);
      const streaming = body.stream === true;
      if (streaming) { res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); await send(res, state.chunk({ role: 'assistant', content: '' })); }
      let outputCharacters = 0;
      for await (const chunk of prepared.chunks()) {
        outputCharacters += typeof chunk.text === 'string' ? chunk.text.length : typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta.length : 0;
        if (outputCharacters > 32 * 1024 * 1024) throw new BridgeError('响应内容超过本机缓冲限制。', 502);
        for (const delta of state.push(chunk)) if (streaming) await send(res, delta);
      }
      const reason = finishReason(state.reason);
      if (streaming) {
        await send(res, state.chunk({}, reason));
        if (body.stream_options?.include_usage) await send(res, { ...state.chunk({}), choices: [], usage: openAIUsage(state.usage) });
        await send(res, '[DONE]'); res.end();
      } else json(res, 200, state.result());
    } catch (error) {
      if (!res.destroyed) {
        if (!res.headersSent) json(res, error instanceof BridgeError ? error.status : 500, errorBody(error));
        else { try { await send(res, errorBody(error)); await send(res, '[DONE]'); res.end(); } catch { res.destroy(); } }
      }
    } finally { active.delete(controller); req.off('aborted', abort); res.off('close', abort); }
  });
  server.requestTimeout = 60000; server.headersTimeout = 15000; server.keepAliveTimeout = 5000;
  Object.defineProperty(server, Symbol.for('dsh.workbuddy.bridge'), { value: 'openai-v3' });
  return { server, async close() {
    sessions.clear(); for (const controller of active) controller.abort(); await auth.close();
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); await syncTail;
  } };
}
