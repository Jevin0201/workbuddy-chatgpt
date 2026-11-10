import { spawn } from 'node:child_process';
import path from 'node:path';

const CURL_PATH = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe');
import { BridgeError } from './errors.js';

const LIMIT = 1024 * 1024;
const OUTPUT_LIMIT = LIMIT + 4096;
const ROUTES = new Set(['https://auth.openai.com/api/accounts/oauth/token', 'https://auth.openai.com/oauth/token']);
const upstreamError = () => new BridgeError('OpenAI connection failed', 502, 'transport_upstream_error');
const abortError = () => new DOMException('The operation was aborted', 'AbortError');

export function createCurlTokenFetch({ proxyUrl, spawnImpl = spawn } = {}) {
  try {
    if (typeof proxyUrl !== 'string' || /\s/.test(proxyUrl) || typeof spawnImpl !== 'function') throw new Error();
    const proxy = new URL(proxyUrl);
    if (!['http:', 'https:'].includes(proxy.protocol) || !proxy.hostname || proxy.username || proxy.password || proxyUrl.includes('@') || proxy.pathname !== '/' || proxy.href.includes('?') || proxy.href.includes('#')) throw new Error();
  } catch {
    throw new BridgeError('Proxy configuration is invalid', 500, 'transport_config_error');
  }
  return async function fetch(input, init = {}) {
    let url;
    let body;
    try {
      if (typeof input !== 'string' && !(input instanceof URL)) throw new Error();
      url = String(input);
      if (!ROUTES.has(url) || init.method !== 'POST') throw new Error();
      if (typeof init.body !== 'string' && !(init.body instanceof URLSearchParams)) throw new Error();
      body = String(init.body);
      if (Buffer.byteLength(body) > LIMIT) throw new Error();
    } catch {
      throw new BridgeError('Token request is invalid', 400, 'transport_request_error');
    }
    const signal = init.signal;
    if (signal?.aborted) throw abortError();
    return new Promise((resolve, reject) => {
      let child;
      let settled = false;
      let size = 0;
      let chunks = [];
      const kill = () => { try { child?.kill(); } catch {} };
      const finish = (error, response) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        chunks = [];
        if (error) { kill(); reject(error); } else resolve(response);
      };
      const onAbort = () => finish(abortError());
      try {
        child = spawnImpl(CURL_PATH, ['--silent', '--show-error', '--connect-timeout', '15', '--max-time', '45', '--max-redirs', '0', '--request', 'POST', '--url', url, '--proxy', proxyUrl, '--header', 'Content-Type: application/x-www-form-urlencoded', '--data-binary', '@-', '--write-out', '\n%{http_code}'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        child.on('error', () => finish(upstreamError()));
        // Late stream errors must remain handled after cancellation.
        child.stdin.on('error', () => finish(upstreamError()));
        child.stdout.on('error', () => finish(upstreamError()));
        child.stderr.on('error', () => finish(upstreamError()));
        child.stderr.on('data', () => {});
        child.stdout.on('data', chunk => {
          if (settled) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > OUTPUT_LIMIT) return finish(upstreamError());
          chunks.push(bytes);
        });
        child.on('close', code => {
          if (settled) return;
          if (code !== 0) return finish(upstreamError());
          try {
            const output = Buffer.concat(chunks);
            const newline = output.lastIndexOf(10);
            const statusBytes = output.subarray(newline + 1);
            if (newline < 0 || statusBytes.length !== 3 || !statusBytes.every(byte => byte >= 48 && byte <= 57) || statusBytes[0] < 49 || statusBytes[0] > 53) throw new Error();
            const status = Number(statusBytes.toString('ascii'));
            if (status < 200) throw new Error();
            const payload = output.subarray(0, newline);
            // Fetch forbids bodies for these statuses, even empty byte buffers.
            const response = new Response([204, 205, 304].includes(status) && payload.length === 0 ? null : payload, { status, headers: { 'content-type': 'application/json' } });
            finish(null, response);
          } catch { finish(upstreamError()); }
        });
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) return onAbort();
        child.stdin.end(body);
      } catch { finish(upstreamError()); }
    });
  };
}
