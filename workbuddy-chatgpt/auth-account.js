import { randomUUID } from 'node:crypto';
import { BridgeError } from './errors.js';

const ACCOUNT = 'workbuddy-openai/account';
const INSTALLATION = 'workbuddy-openai/installation';
const SCOPE = 'chatgpt.tokens.use.direct';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status, code, message) => new BridgeError(message, status, code);
const aborted = () => fail(499, 'AUTH_CANCELLED', '\u767b\u5f55\u5df2\u53d6\u6d88');
function grant(record) {
  const p = record?.kind === 'grant' ? record.payload : undefined;
  return p?.type === 'oauth' && typeof p.access === 'string' && p.access.length > 0 &&
    typeof p.refresh === 'string' && p.refresh.length > 0 &&
    typeof p.clientId === 'string' && p.clientId.length > 0 &&
    Number.isFinite(p.expires) && Array.isArray(p.scopes) && p.scopes.includes(SCOPE) ? p : undefined;
}
function sanitized(error) {
  const messages = {
    transport_upstream_error: '\u540e\u53f0\u8fde\u63a5 OpenAI \u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u672c\u673a\u4ee3\u7406\u540e\u91cd\u8bd5\u3002',
    AUTH_DENIED: '\u5df2\u53d6\u6d88 ChatGPT \u6388\u6743\uff0c\u53ef\u91cd\u65b0\u767b\u5f55\u3002',
    OPENAI_NETWORK_TIMEOUT: '\u8fde\u63a5 OpenAI \u8d85\u65f6\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u6216\u4ee3\u7406\u540e\u91cd\u8bd5\u3002',
    OPENAI_NETWORK_FAILED: '\u8fde\u63a5 OpenAI \u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u6216\u4ee3\u7406\u540e\u91cd\u8bd5\u3002',
    AUTH_GRANT_SCHEMA: 'OpenAI \u6388\u6743\u54cd\u5e94\u683c\u5f0f\u5f02\u5e38\uff0c\u8bf7\u91cd\u65b0\u767b\u5f55\u3002',
    AUTH_SCOPE_MISSING: '\u6388\u6743\u7f3a\u5c11\u76f4\u63a5\u8bbf\u95ee\u6743\u9650\uff0c\u8bf7\u91cd\u65b0\u767b\u5f55\u5e76\u5b8c\u6210\u6388\u6743\u3002',
    AUTH_TOKEN_HTTP_FAILED: 'OpenAI \u4ee4\u724c\u8bf7\u6c42\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5\u3002',
  };
  if (Object.hasOwn(messages, error?.code)) return { code: error.code, message: messages[error.code] };
  if (typeof error?.code === 'string' && /^AUTH_TOKEN_HTTP_[45]\d{2}$/.test(error.code)) {
    const status = Number(error.code.slice(-3));
    const message = [400, 401, 403].includes(status) ? 'OpenAI \u4ee4\u724c\u6388\u6743\u672a\u901a\u8fc7\uff0c\u8bf7\u91cd\u65b0\u767b\u5f55\u3002' :
      'OpenAI \u4ee4\u724c\u670d\u52a1\u6682\u65f6\u5f02\u5e38\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002';
    return { code: error.code, message };
  }
  if (error?.code === 'EADDRINUSE' || /port 1455.*in use|EADDRINUSE/i.test(String(error?.message))) {
    return { code: 'CALLBACK_PORT_BUSY', message: '\u767b\u5f55\u56de\u8c03\u7aef\u53e3 1455 \u6b63\u5728\u4f7f\u7528\u3002\u8bf7\u5148\u53d6\u6d88\u5176\u4ed6 ChatGPT/Codex \u767b\u5f55\uff0c\u7136\u540e\u91cd\u8bd5\u3002' };
  }
  return { code: 'AUTH_FAILED', message: '\u767b\u5f55\u672a\u5b8c\u6210\uff0c\u8bf7\u91cd\u8bd5\u3002' };
}

export function createAccountAuth(ctx, { oauth, now = Date.now } = {}) {
  if (!oauth?.login || !oauth?.refresh) throw new TypeError('ChatGPT OAuth provider required');
  const credentials = ctx.credentials;
  let active;
  let closed = false;
  let state = 'idle';
  let error = null;

  async function status() {
    const configured = !!grant(await credentials.readRecord(ACCOUNT));
    return {
      configured,
      state: state === 'idle' && configured ? 'authorized' : state,
      notices: active ? structuredClone(active.notices) : [],
      prompt: active?.pending ? structuredClone(active.pending.public) : null,
      error: error ? { ...error } : null,
    };
  }
  function prompt(attempt, request) {
    return new Promise((resolve, reject) => {
      const signal = request.signal ? AbortSignal.any([attempt.controller.signal, request.signal]) : attempt.controller.signal;
      if (signal.aborted || active !== attempt) return reject(aborted());
      if (attempt.pending) return reject(fail(409, 'PROMPT_PENDING', 'Prompt already pending'));
      if (!['manual_code', 'select', 'secret'].includes(request.type)) return reject(new Error('Unsupported OAuth prompt'));
      const publicPrompt = { id: randomUUID(), kind: request.type, message: String(request.message || '') };
      if (typeof request.placeholder === 'string') publicPrompt.placeholder = request.placeholder;
      if (request.type === 'select') publicPrompt.options = (request.options || []).map(({ id, label }) => ({ id, label }));
      const finish = (value, reason) => {
        signal.removeEventListener('abort', onAbort);
        if (attempt.pending?.public.id === publicPrompt.id) attempt.pending = null;
        if (reason) reject(reason); else resolve(value);
      };
      const onAbort = () => finish(undefined, aborted());
      attempt.pending = { public: publicPrompt, finish };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }
  async function run(attempt) {
    const signal = attempt.controller.signal;
    try {
      const installation = await credentials.modifyRecord(INSTALLATION, async current => {
        signal.throwIfAborted();
        if (current?.kind === 'grant' && UUID.test(current.payload?.deviceId || '')) return undefined;
        return { kind: 'grant', payload: { deviceId: randomUUID() } };
      });
      signal.throwIfAborted();
      const interaction = {
        signal,
        notify(event) {
          if (signal.aborted || active !== attempt) return;
          if (event.type === 'auth_url') {
            const url = new URL(event.url);
            if (url.protocol === 'https:' && url.hostname === 'auth.openai.com' && !url.username && !url.password) {
              attempt.notices = [{ type: 'auth_url', url: url.href }];
              for (const subscriber of [...attempt.subscribers]) subscriber(url.href);
            }
          } else if (event.type === 'progress') {
            attempt.notices = attempt.notices.filter(n => n.type !== 'progress');
            attempt.notices.push({ type: 'progress', message: '\u6b63\u5728\u5b8c\u6210 ChatGPT \u6388\u6743' });
          }
        },
        prompt: request => prompt(attempt, request),
      };
      // Race the provider too: a misbehaving provider must never keep a login alive forever.
      let removeAbort;
      const interruption = new Promise((_, reject) => {
        const onAbort = () => reject(aborted());
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbort = () => signal.removeEventListener('abort', onAbort);
      });
      let payload;
      try {
        payload = await Promise.race([
          Promise.resolve().then(() => { signal.throwIfAborted(); return oauth.login(interaction, {
            getDeviceId: () => installation.payload.deviceId,
            agentName: 'WorkBuddy OpenAI Bridge',
          }); }), interruption,
        ]);
      } finally { removeAbort(); }
      signal.throwIfAborted();
      if (!grant({ kind: 'grant', payload })) throw new Error('Invalid direct ChatGPT grant');
      await credentials.modifyRecord(ACCOUNT, async current => {
        signal.throwIfAborted();
        return { ...current, kind: 'grant', payload };
      });
      state = 'authorized';
    } catch (cause) {
      state = signal.aborted ? (attempt.timedOut ? 'failed' : 'cancelled') : 'failed';
      error = signal.aborted ? (attempt.timedOut ? { code: 'AUTH_TIMEOUT', message: '\u767b\u5f55\u5df2\u8d85\u65f6\uff0c\u8bf7\u91cd\u8bd5\u3002' } : null) : sanitized(cause);
    } finally {
      clearTimeout(attempt.timer);
      attempt.controller.abort();
      attempt.notices = [];
      if (active === attempt) active = undefined;
      const reason = closed ? fail(410, 'AUTH_CLOSED', 'Account authorization closed') :
        state === 'cancelled' ? aborted() :
          fail(502, error?.code || 'AUTH_URL_UNAVAILABLE', error?.message || 'Authorization settled before URL');
      for (const subscriber of [...attempt.subscribers]) subscriber(undefined, reason);
    }
  }
  async function authorizationUrl({ signal, timeoutMs = 15000 } = {}) {
    if (closed) throw fail(410, 'AUTH_CLOSED', 'Account authorization closed');
    if (signal?.aborted) throw aborted();
    const attempt = active;
    if (!attempt) throw fail(409, 'AUTH_NOT_RUNNING', 'Account authorization is not running');
    const url = attempt.notices.find(notice => notice.type === 'auth_url')?.url;
    if (url) return url;
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (value, reason) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        attempt.subscribers.delete(finish);
        if (reason) reject(reason); else resolve(value);
      };
      const onAbort = () => finish(undefined, aborted());
      attempt.subscribers.add(finish);
      signal?.addEventListener('abort', onAbort, { once: true });
      const wait = Number.isFinite(timeoutMs) ? Math.max(0, Math.min(timeoutMs, 15000)) : 15000;
      timer = setTimeout(() => finish(undefined, fail(504, 'AUTH_URL_TIMEOUT', 'Authorization URL timed out')), wait);
      timer.unref?.();
      if (signal?.aborted) onAbort();
    });
  }
  async function start() {
    if (closed) throw fail(410, 'AUTH_CLOSED', 'Account authorization closed');
    if (active) throw fail(409, 'AUTH_RUNNING', '\u767b\u5f55\u6b63\u5728\u8fdb\u884c');
    const attempt = { controller: new AbortController(), notices: [], pending: null, subscribers: new Set() };
    active = attempt;
    state = 'running';
    error = null;
    attempt.timer = setTimeout(() => { attempt.timedOut = true; attempt.controller.abort(); }, 10 * 60 * 1000);
    attempt.timer.unref?.();
    attempt.task = run(attempt);
    return status();
  }
  async function answer(body) {
    const pending = active?.pending;
    if (!pending || pending.public.id !== body?.id) throw fail(409, 'STALE_PROMPT', '\u767b\u5f55\u63d0\u793a\u5df2\u66f4\u65b0');
    if (typeof body.value !== 'string' || body.value.length === 0 || body.value.length > 32768) throw fail(400, 'INVALID_ANSWER', 'Invalid prompt answer');
    if (pending.public.kind === 'select' && !pending.public.options.some(option => option.id === body.value)) throw fail(400, 'INVALID_ANSWER', 'Invalid prompt choice');
    pending.finish(body.value);
    return status();
  }
  async function cancel() {
    const attempt = active;
    if (attempt) {
      attempt.controller.abort();
      await attempt.task;
    }
    return status();
  }
  async function accessToken(signal) {
    if (closed) throw fail(410, 'AUTH_CLOSED', 'Account authorization closed');
    signal?.throwIfAborted();
    const initial = grant(await credentials.readRecord(ACCOUNT));
    signal?.throwIfAborted();
    if (!initial) throw fail(401, 'AUTH_REQUIRED', '\u8bf7\u5148\u767b\u5f55 ChatGPT \u5e76\u6388\u4e88\u76f4\u63a5\u8bbf\u95ee\u6743\u9650');
    if (initial.expires > now()) return initial.access;
    try {
      const record = await credentials.modifyRecord(ACCOUNT, async current => {
        signal?.throwIfAborted();
        const currentGrant = grant(current);
        if (!currentGrant) throw fail(401, 'AUTH_REQUIRED', 'ChatGPT login required');
        if (currentGrant.expires > now()) return undefined;
        const next = await oauth.refresh(currentGrant, signal);
        signal?.throwIfAborted();
        if (!grant({ kind: 'grant', payload: next })) throw new Error('Invalid direct ChatGPT refresh grant');
        return { ...current, payload: { ...currentGrant, ...next } };
      });
      signal?.throwIfAborted();
      return grant(record).access;
    } catch (cause) {
      if (signal?.aborted) throw signal.reason;
      const detail = sanitized(cause);
      if (detail.code !== 'AUTH_FAILED') throw fail(['OPENAI_NETWORK_TIMEOUT', 'OPENAI_NETWORK_FAILED', 'transport_upstream_error'].includes(detail.code) || /^AUTH_TOKEN_HTTP_5\d{2}$/.test(detail.code) ? 502 : 401, detail.code, detail.message);
      throw fail(401, 'AUTH_REFRESH_FAILED', '\u767b\u5f55\u5df2\u8fc7\u671f\uff0c\u8bf7\u91cd\u65b0\u767b\u5f55 ChatGPT');
    }
  }
  async function close() { closed = true; await cancel(); }
  return { status, start, authorizationUrl, answer, cancel, accessToken, close };
}
