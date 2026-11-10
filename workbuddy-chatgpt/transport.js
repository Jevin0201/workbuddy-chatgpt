import { BridgeError } from './errors.js';

const ROUTES = new Map([
  ['https://auth.openai.com/api/accounts/oauth/token', 'POST'],
  ['https://auth.openai.com/oauth/token', 'POST'],
  ['https://api.openai.com/v1/models', 'GET'],
  ['https://api.openai.com/v1/responses', 'POST'],
  ['https://chatgpt.com/backend-api/wham/usage', 'GET'],
]);
const failure = (message, status, code) => new BridgeError(message, status, code);

export function createScopedTransport({ proxyUrl = '', ProxyAgent, fetchImpl = globalThis.fetch, tokenFetchImpl } = {}) {
  if (typeof fetchImpl !== 'function' || tokenFetchImpl !== undefined && typeof tokenFetchImpl !== 'function') throw failure('Transport configuration is invalid', 500, 'transport_config_error');
  let dispatcher;
  if (proxyUrl !== '') {
    try {
      if (typeof proxyUrl !== 'string' || /\s/.test(proxyUrl)) throw new Error();
      const proxy = new URL(proxyUrl);
      if (!['http:', 'https:'].includes(proxy.protocol) || !proxy.hostname || proxy.pathname !== '/' || proxy.href.includes('?') || proxy.href.includes('#')) throw new Error();
      if (typeof ProxyAgent !== 'function') throw new Error();
      dispatcher = new ProxyAgent({ uri: proxyUrl });
    } catch {
      throw failure('Proxy configuration is invalid', 500, 'transport_config_error');
    }
  }
  let closed = false;
  let closing;
  return {
    async fetch(input, init = {}) {
      if (closed) throw failure('Transport is closed', 503, 'transport_closed');
      let url;
      try {
        if (typeof input !== 'string' && !(input instanceof URL)) throw new Error();
        url = new URL(input);
        if (url.username || url.password || url.href.includes('?') || url.href.includes('#') || !ROUTES.has(url.href)) throw new Error();
        const method = init.method ?? 'GET';
        if (method !== ROUTES.get(url.href)) throw new Error();
      } catch {
        throw failure('Transport destination or method is invalid', 400, 'transport_request_error');
      }
      try {
        if (tokenFetchImpl && url.origin === 'https://auth.openai.com') return await tokenFetchImpl(url.href, { ...init, redirect: 'error' });
        return await fetchImpl(url.href, { ...init, dispatcher, redirect: 'error' });
      } catch {
        throw failure('OpenAI connection failed', 502, 'transport_upstream_error');
      }
    },
    close() {
      if (!closed) {
        closed = true;
        closing = Promise.resolve().then(() => dispatcher?.close()).catch(() => {
          throw failure('Transport shutdown failed', 502, 'transport_close_error');
        });
      }
      return closing;
    },
  };
}
