const SOURCE = 'current ChatGPT account';
const MAX_BODY = 1024 * 1024;
const text = value => typeof value === 'string' && value.length < 200 ? value : undefined;
const unavailable = reason => ({ available: false, reason });
function window(value, name) {
  if (!value || !Number.isFinite(value.used_percent) || value.used_percent < 0 || value.used_percent > 100) return undefined;
  const result = { name, usedPercent: value.used_percent, remainingPercent: 100 - value.used_percent };
  if (Number.isFinite(value.reset_at) && value.reset_at > 0) result.resetAt = value.reset_at;
  if (Number.isFinite(value.limit_window_seconds) && value.limit_window_seconds > 0) result.windowSeconds = value.limit_window_seconds;
  return result;
}
export function sanitizeQuota(data, fetchedAt) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return unavailable('\u989d\u5ea6\u54cd\u5e94\u683c\u5f0f\u5f02\u5e38');
  const windows = [];
  function add(rate, name) {
    for (const [key, suffix] of [['primary_window', 'primary'], ['secondary_window', 'secondary']]) {
      const item = window(rate?.[key], `${name} ${suffix}`);
      if (item) windows.push(item);
    }
  }
  add(data.rate_limit, 'Codex');
  if (Array.isArray(data.additional_rate_limits)) {
    for (const extra of data.additional_rate_limits.slice(0, 100)) {
      add(extra?.rate_limit, text(extra?.limit_name) || text(extra?.metered_feature) || 'Codex model');
    }
  }
  const result = { available: true, source: SOURCE, windows, fetchedAt };
  if (text(data.plan_type)) result.planType = data.plan_type;
  if (data.credits && typeof data.credits === 'object') {
    const credits = {};
    if (typeof data.credits.balance === 'string' && /^-?\d+(?:\.\d+)?$/.test(data.credits.balance) && data.credits.balance.length <= 100) credits.balance = data.credits.balance;
    if (typeof data.credits.unlimited === 'boolean') credits.unlimited = data.credits.unlimited;
    if (text(data.credits.unit)) credits.unit = data.credits.unit;
    if (Object.keys(credits).length) result.credits = credits;
  }
  if (!windows.length && !result.credits && !result.planType) return unavailable('\u989d\u5ea6\u54cd\u5e94\u672a\u5305\u542b\u53ef\u7528\u6570\u636e');
  return result;
}
async function boundedJSON(response) {
  const length = response.headers?.get?.('content-length');
  if (length && Number(length) > MAX_BODY) throw new Error('Body too large');
  if (!response.body?.getReader) throw new Error('Streaming response required');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) throw new Error('Body too large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function createQuotaReader({ auth, fetchImpl = fetch }) {
  let cache;
  const pending = new Map();
  async function read(signal, force = false) {
    let token;
    try { token = await auth.accessToken(signal); }
    catch { return unavailable('登录已失效，请在插件中重新登录 ChatGPT'); }
    const context = await auth.accountContext();
    if (context.mode !== 'subscription') return unavailable('请在插件中重新登录 ChatGPT，以启用当前账号的额度查询');
    if (!force && cache?.key === token && Date.now() - cache.time < 60000) return structuredClone(cache.value);
    if (pending.has(token)) return structuredClone(await pending.get(token));
    const operation = (async () => {
      let value;
      try {
        const response = await fetchImpl('https://chatgpt.com/backend-api/wham/usage', {
          method: 'GET', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(context.accountId ? { 'chatgpt-account-id': context.accountId } : {}) },
        });
        if (!response.ok) {
          await response.body?.cancel();
          value = unavailable(response.status === 401 ? '账号授权已失效，请在插件中重新登录 ChatGPT' : '当前账号额度读取失败，请稍后刷新');
        } else value = sanitizeQuota(await boundedJSON(response), Date.now());
      } catch { value = unavailable('网络请求失败，请检查网络后刷新额度'); }
      try { if (await auth.accessToken(signal) !== token) return unavailable('账号已切换，请刷新额度'); }
      catch { return unavailable('登录已失效，请重新登录 ChatGPT'); }
      cache = { key: token, time: Date.now(), value };
      return value;
    })();
    pending.set(token, operation);
    try { return structuredClone(await operation); } finally { pending.delete(token); }
  }
  return { read };
}
