import { BridgeError } from './errors.js';

const MODELS_URL = 'https://api.openai.com/v1/models';
const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const JSON_LIMIT = 4 * 1024 * 1024;
const EVENT_LIMIT = 8 * 1024 * 1024;
const CACHE_MS = 60_000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const cleanString = value => typeof value === 'string' && value.trim().length > 0;
const failure = (message, status = 502, code = 'upstream_error') => new BridgeError(message, status, code);
const abortError = () => new DOMException('Request aborted', 'AbortError');
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
function redact(value, token) {
  if (typeof value === 'string') return token ? value.split(token).join('[redacted]') : value;
  if (Array.isArray(value)) return value.map(item => redact(item, token));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, token)]));
  return value;
}
function reasoningFor(model) {
  const candidates = [
    [model.supported_reasoning_levels, item => object(item) && cleanString(item.effort) ? { id: item.effort, name: cleanString(item.description) ? item.description : item.effort } : null],
    [model.reasoning_efforts, item => cleanString(item) ? { id: item, name: item } : null],
    [model.supported_reasoning_efforts, item => cleanString(item) ? { id: item, name: item } : null],
    [model.reasoning?.efforts, item => object(item) && cleanString(item.id) ? { id: item.id, name: cleanString(item.name) ? item.name : item.id } : null],
  ];
  for (const [raw, convert] of candidates) {
    if (!Array.isArray(raw)) continue;
    const efforts = raw.map(convert);
    if (efforts.some(item => item === null)) continue;
    const unique = [...new Map(efforts.map(item => [item.id, item])).values()];
    const result = { efforts: unique, source: 'reported' };
    const defaultEffort = model.default_reasoning_level ?? model.reasoning?.defaultEffort;
    if (typeof defaultEffort === 'string' && unique.some(item => item.id === defaultEffort)) result.defaultEffort = defaultEffort;
    return result;
  }
  return { efforts: [], source: 'unreported' };
}
function normalizeModels(payload) {
  if (!object(payload) || !Array.isArray(payload.models)) {
    throw failure('Account model response has an unsupported schema', 502, 'invalid_model_schema');
  }
  const seen = new Set();
  const models = [];
  for (const model of payload.models) {
    if (!object(model) || model.visibility !== 'list') continue;
    if (!cleanString(model.slug)) throw failure('Account model entry is missing its identifier', 502, 'invalid_model_schema');
    if (seen.has(model.slug)) continue;
    seen.add(model.slug);
    const result = { id: model.slug, name: cleanString(model.display_name) ? model.display_name : cleanString(model.title) ? model.title : cleanString(model.name) ? model.name : model.slug, reasoning: reasoningFor(model) };
    if (Number.isSafeInteger(model.context_window) && model.context_window > 0) result.contextWindow = model.context_window;
    if (Number.isSafeInteger(model.max_output_tokens) && model.max_output_tokens > 0) result.maxTokens = model.max_output_tokens;
    if (Array.isArray(model.input_modalities) && model.input_modalities.every(cleanString)) result.inputModalities = [...new Set(model.input_modalities)];
    models.push(result);
  }
  return models;
}
async function* chunks(body, signal) {
  if (!body || typeof body.getReader !== 'function') throw failure('Upstream response body is missing');
  const reader = body.getReader();
  const cancel = () => { Promise.resolve(reader.cancel()).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      checkAbort(signal);
      let part;
      try { part = await reader.read(); }
      catch { checkAbort(signal); throw failure('Upstream response could not be read'); }
      checkAbort(signal);
      if (part.done) return;
      yield part.value;
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    try { await reader.cancel(); } catch { /* Release a partially consumed network body. */ }
    reader.releaseLock();
  }
}
async function boundedJson(response, signal) {
  const length = Number(response.headers?.get('content-length'));
  if (Number.isFinite(length) && length > JSON_LIMIT) { await response.body?.cancel().catch(() => {}); throw failure('Upstream JSON exceeds the size limit'); }
  let size = 0;
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of chunks(response.body, signal)) {
    size += chunk.byteLength;
    if (size > JSON_LIMIT) throw failure('Upstream JSON exceeds the size limit');
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  try { return JSON.parse(text); } catch { throw failure('Upstream returned invalid JSON'); }
}

export function createOfficialApi({ auth, fetchImpl = globalThis.fetch, now = Date.now, extraHeaders, quotaProvider } = {}) {
  if (typeof auth?.accessToken !== 'function' || typeof fetchImpl !== 'function') throw new TypeError('auth.accessToken and fetchImpl are required');
  let cached;
  let cachedAt = 0;
  let cachedForToken;
  async function accessToken(signal) {
    checkAbort(signal);
    let token;
    try { token = await auth.accessToken(signal); } catch { checkAbort(signal); throw failure('OpenAI sign-in is required', 401, 'authentication_required'); }
    checkAbort(signal);
    if (!cleanString(token)) throw failure('OpenAI sign-in is required', 401, 'authentication_required');
    return token;
  }
  async function request(url, options, signal, suppliedToken) {
    const token = suppliedToken ?? await accessToken(signal);
    let response;
    try {
      const headers = new Headers(typeof extraHeaders === 'function' ? await extraHeaders() : extraHeaders);
      headers.delete('Host');
      for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value);
      headers.delete('Authorization');
      checkAbort(signal);
      response = await fetchImpl(url, { ...options, signal, redirect: 'error', headers: { ...Object.fromEntries(headers), Authorization: `Bearer ${token}` } });
    }
    catch { checkAbort(signal); throw failure('OpenAI request failed'); }
    checkAbort(signal);
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* Error bodies are deliberately discarded. */ }
      const status = [401, 403, 429].includes(response.status) ? response.status : 502;
      throw failure(`OpenAI request returned HTTP ${Number.isInteger(response.status) ? response.status : 502}`, status, status === 401 ? 'authentication_required' : 'upstream_error');
    }
    return { response, token };
  }
  return {
    async models({ force = false, signal } = {}) {
      const currentToken = await accessToken(signal);
      if (!force && cached && cachedForToken === currentToken && now() - cachedAt < CACHE_MS) return structuredClone(cached);
      const { response, token } = await request(MODELS_URL, { method: 'GET', headers: { Accept: 'application/json' } }, signal, currentToken);
      const models = normalizeModels(redact(await boundedJson(response, signal), token));
      cachedAt = now();
      cachedForToken = token;
      cached = { models, source: 'account', fetchedAt: new Date(cachedAt).toISOString(), warnings: [] };
      return structuredClone(cached);
    },
    async usage({ signal } = {}) {
      checkAbort(signal);
      // A separate provider must own its own authorized grant and sanitize its result.
      if (typeof quotaProvider === 'function') {
        try {
          const result = await quotaProvider(signal);
          checkAbort(signal);
          if (object(result) && typeof result.available === 'boolean') return structuredClone(result);
        } catch { checkAbort(signal); }
        return { available: false, reason: 'subscription_quota_unavailable' };
      }
      return { available: false, reason: 'subscription_quota_unreported' };
    },
    async *streamResponses(body, { signal } = {}) {
      if (!object(body)) throw failure('Responses request must be an object', 400, 'invalid_request_error');
      let encoded;
      try { encoded = JSON.stringify({ ...body, stream: true }); } catch { throw failure('Responses request must be JSON serializable', 400, 'invalid_request_error'); }
      const { response, token } = await request(RESPONSES_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: encoded }, signal);
      const contentType = response.headers?.get('content-type') ?? '';
      // The account endpoint may omit Content-Type while returning valid SSE.
      // The event parser below still requires valid events and a terminal response.
      if (contentType && !contentType.toLowerCase().includes('text/event-stream')) {
        try { await response.body?.cancel(); } catch { /* Discard unexpected bodies. */ }
        throw failure('OpenAI returned an unexpected stream content type');
      }
      const decoder = new TextDecoder();
      let line = '';
      let data = [];
      let eventName = '';
      let bytes = 0;
      let terminal = false;
      let skipLF = false;
      function consumeLine() {
        const current = line;
        line = '';
        if (current === '') {
          const payload = data.join('\n');
          data = [];
          bytes = 0;
          const event = eventName;
          eventName = '';
          if (!payload || payload === '[DONE]') return null;
          let parsed;
          try { parsed = JSON.parse(payload); } catch { throw failure('OpenAI stream contained invalid JSON'); }
          if (!object(parsed)) throw failure('OpenAI stream contained an invalid event');
          if (!cleanString(parsed.type) && cleanString(event)) parsed.type = event;
          if (!cleanString(parsed.type)) throw failure('OpenAI stream event is missing its type');
          if (parsed.type === 'error') return { type: 'error', error: { message: 'OpenAI stream reported an error', code: 'upstream_error' } };
          if (parsed.type === 'response.failed' || parsed.type === 'response.incomplete') {
            // Keep terminal status and token usage, but never upstream diagnostic text.
            const source = object(parsed.response) ? parsed.response : {};
            const result = { type: parsed.type, response: { status: parsed.type === 'response.failed' ? 'failed' : 'incomplete' } };
            if (cleanString(source.id)) result.response.id = source.id;
            if (object(source.usage)) result.response.usage = source.usage;
            if (parsed.type === 'response.failed') result.response.error = { code: 'upstream_error', message: 'OpenAI response failed' };
            if (parsed.type === 'response.incomplete') result.response.incomplete_details = { reason: ['max_output_tokens', 'content_filter'].includes(source.incomplete_details?.reason) ? source.incomplete_details.reason : 'unreported' };
            return redact(result, token);
          }
          return redact(parsed, token);
        }
        if (current.startsWith(':')) return null;
        const separator = current.indexOf(':');
        const field = separator < 0 ? current : current.slice(0, separator);
        let value = separator < 0 ? '' : current.slice(separator + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') data.push(value);
        if (field === 'event') eventName = value;
        return null;
      }
      function* consumeText(text) {
        for (const char of text) {
          if (skipLF) { skipLF = false; if (char === '\n') continue; }
          // Reserve a possible following LF before a CR can dispatch/reset an event.
          bytes += char === '\r' ? 2 : Buffer.byteLength(char);
          if (bytes > EVENT_LIMIT) throw failure('OpenAI stream event exceeds the size limit');
          if (char === '\r' || char === '\n') {
            if (char === '\r') skipLF = true;
            const event = consumeLine();
            if (event) yield event;
          } else line += char;
        }
      }
      for await (const chunk of chunks(response.body, signal)) {
        for (const event of consumeText(decoder.decode(chunk, { stream: true }))) {
          if (['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(event.type)) terminal = true;
          yield event;
          if (terminal) return;
        }
      }
      for (const event of consumeText(decoder.decode())) {
        if (['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(event.type)) terminal = true;
        yield event;
      }
      // SSE events require a terminating blank line; truncated frames never imply success.
      if (!terminal) throw failure('OpenAI stream ended before a terminal event', 502, 'incomplete_stream');
    },
  };
}
