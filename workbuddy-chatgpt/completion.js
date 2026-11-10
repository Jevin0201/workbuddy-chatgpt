import { randomUUID } from 'node:crypto';
import { BridgeError } from './errors.js';

export function openAIUsage(usage = {}) {
  const prompt = usage.inputTokens ?? 0;
  const completion = usage.outputTokens ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: usage.totalTokens ?? prompt + completion,
    ...(usage.cacheReadTokens === undefined ? {} : { prompt_tokens_details: { cached_tokens: usage.cacheReadTokens } }) };
}
export function finishReason(reason) {
  if (reason?.kind === 'error' || reason?.kind === 'aborted') throw new BridgeError('Upstream request failed', reason.kind === 'aborted' ? 499 : 502, reason.failure?.code ?? 'upstream_error');
  const mapped = { stop: 'stop', 'max-tokens': 'length', 'tool-calls': 'tool_calls' }[reason?.kind];
  if (!mapped) throw new BridgeError('Upstream stream ended without a valid finish', 502, 'stream_closed');
  return mapped;
}
export class CompletionState {
  constructor(model) { this.model = model; this.id = `chatcmpl-${randomUUID()}`; this.created = Math.floor(Date.now() / 1000); this.blocks = new Map(); this.tools = new Map(); }
  chunk(delta, finish_reason = null) { return { id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [{ index: 0, delta, finish_reason }] }; }
  push(chunk) {
    let p = this.blocks.get(chunk.index);
    if (chunk.type === 'usage') { this.usage = chunk.usage; return []; }
    if (chunk.type === 'finish') { this.reason = chunk.reason; return []; }
    if (chunk.type === 'block-start') { if (!p) this.blocks.set(chunk.index, { type: chunk.blockType, text: '', arguments: '' }); return []; }
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      if (!p) { p = { type: chunk.type === 'text-delta' ? 'text' : 'reasoning', text: '' }; this.blocks.set(chunk.index, p); }
      if (p.closed) return [];
      p.text += chunk.text;
      return chunk.type === 'text-delta' ? [this.chunk({ content: chunk.text })] : [];
    }
    if (chunk.type === 'tool-call-delta') {
      if (!p) { p = { type: 'tool-call', arguments: '' }; this.blocks.set(chunk.index, p); }
      if (p.closed) return [];
      p.id = chunk.id || p.id; p.name = chunk.name || p.name; p.arguments += chunk.argumentsDelta;
      return this.toolDelta(chunk.index, p, chunk.argumentsDelta);
    }
    if (chunk.type === 'block-end') {
      const block = chunk.block;
      if (p?.closed) return [];
      const out = [];
      if (block.type === 'text') {
        const previous = p?.text ?? '';
        if (!block.text.startsWith(previous)) throw new BridgeError('Inconsistent upstream text stream', 502);
        if (block.text.length > previous.length) out.push(this.chunk({ content: block.text.slice(previous.length) }));
      } else if (block.type === 'tool-call') {
        const previous = p?.arguments ?? '';
        if (!block.arguments.startsWith(previous)) throw new BridgeError('Inconsistent upstream tool stream', 502);
        out.push(...this.toolDelta(chunk.index, block, block.arguments.slice(previous.length)));
      }
      this.blocks.set(chunk.index, { ...block, closed: true }); return out;
    }
    return [];
  }
  toolDelta(index, block, args) {
    if (!block.id || !block.name) return [];
    let tool = this.tools.get(index); const first = !tool;
    if (!tool) { tool = { index: this.tools.size, id: block.id, name: block.name }; this.tools.set(index, tool); }
    if (tool.id !== block.id || tool.name !== block.name) throw new BridgeError('Inconsistent upstream tool identity', 502);
    return [this.chunk({ tool_calls: [{ index: tool.index, ...(first ? { id: block.id, type: 'function' } : {}), function: { ...(first ? { name: block.name } : {}), arguments: first ? block.arguments : args } }] })];
  }
  result() {
    const reason = finishReason(this.reason);
    const blocks = [...this.blocks.values()];
    const calls = reason === 'length' ? [] : blocks.filter(b => b.type === 'tool-call').map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments } }));
    return { id: this.id, object: 'chat.completion', created: this.created, model: this.model, choices: [{ index: 0, message: { role: 'assistant', content: blocks.filter(b => b.type === 'text').map(b => b.text).join('') || (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: reason }], usage: openAIUsage(this.usage) };
  }
}
