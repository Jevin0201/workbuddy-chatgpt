import { BridgeError } from './errors.js';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new BridgeError(message); };
function contentParts(content, role) {
  if (content === null || content === undefined) return [];
  const type = role === 'assistant' ? 'output_text' : 'input_text';
  if (typeof content === 'string') return [{ type, text: content }];
  if (!Array.isArray(content)) fail('消息内容应为文本或文本数组。');
  return content.map(part => {
    if (!record(part) || part.type !== 'text' || typeof part.text !== 'string') fail('当前桥接支持文本消息；图像和音频尚未接入。');
    return { type, text: part.text };
  });
}

export function responsesRequest(body, model, defaultEffort) {
  if (!record(body) || !Array.isArray(body.messages) || !body.messages.length) fail('messages 应为非空数组。');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') fail('stream 应为布尔值。');
  if (body.n !== undefined && body.n !== 1) fail('当前每次请求仅支持一个回答。');
  for (const field of ['functions', 'function_call', 'response_format', 'audio', 'modalities', 'logprobs', 'logit_bias', 'seed']) {
    if (body[field] !== undefined) fail(`暂未适配参数：${field}`);
  }
  if (body.stop !== undefined && body.stop !== null && !(Array.isArray(body.stop) && body.stop.length === 0)) fail('Responses 接口未适配 stop 参数。');
  const input = [];
  const callIds = new Set();
  for (const message of body.messages) {
    if (!record(message)) fail('消息格式错误。');
    if (message.role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || !callIds.has(message.tool_call_id)) fail('工具结果缺少对应的工具调用。');
      const parts = contentParts(message.content, 'user');
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: parts.map(part => part.text).join('\n') });
      continue;
    }
    if (!['system', 'developer', 'user', 'assistant'].includes(message.role)) fail('消息角色不受支持。');
    const role = message.role === 'system' ? 'developer' : message.role;
    const content = contentParts(message.content, role);
    if (content.length) input.push({ role, content });
    if (message.tool_calls !== undefined && (message.role !== 'assistant' || !Array.isArray(message.tool_calls))) fail('工具调用历史格式错误。');
    for (const call of message.tool_calls ?? []) {
      if (!record(call) || call.type !== 'function' || typeof call.id !== 'string' || !record(call.function) || typeof call.function.name !== 'string' || typeof call.function.arguments !== 'string' || callIds.has(call.id)) fail('工具调用格式错误。');
      try { if (!record(JSON.parse(call.function.arguments))) fail('工具参数应为 JSON 对象。'); } catch { fail('工具参数应为 JSON 对象。'); }
      callIds.add(call.id);
      input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
  }
  if (!input.length) fail('请求至少需要一条非空消息。');
  const request = { model: model.id, input, store: false, stream: true };
  const effort = body.reasoning_effort ?? body.reasoning?.effort ?? defaultEffort;
  if (effort !== undefined && effort !== null && effort !== '' && effort !== 'default' && effort !== 'auto') {
    const efforts = model.reasoning?.efforts ?? [];
    if (typeof effort !== 'string' || !efforts.some(item => item.id === effort)) fail('所选档位不在该账号模型公开的档位列表中，请刷新目录。');
    request.reasoning = { effort };
  }
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (maxTokens !== undefined) {
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) fail('输出 token 上限应为正整数。');
    request.max_output_tokens = maxTokens;
  }
  for (const [key, max] of [['temperature', 2], ['top_p', 1]]) {
    if (body[key] === undefined || body[key] === null) continue;
    if (typeof body[key] !== 'number' || !Number.isFinite(body[key]) || body[key] < 0 || body[key] > max) fail(`${key} 超出有效范围。`);
    request[key] = body[key];
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > 128) fail('工具列表格式错误或超过 128 项。');
    const names = new Set();
    const tools = body.tools.map(tool => {
      if (tool?.type !== 'function' || !record(tool.function) || typeof tool.function.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.function.name) || names.has(tool.function.name)) fail('工具名称格式错误或重复。');
      names.add(tool.function.name);
      if (!record(tool.function.parameters)) fail('工具参数 schema 应为对象。');
      return { type: 'function', name: tool.function.name, description: String(tool.function.description ?? ''), parameters: tool.function.parameters, ...(tool.function.strict === undefined ? {} : { strict: tool.function.strict }) };
    });
    if (tools.length) request.tools = [{ type: 'namespace', name: 'workbuddy', description: 'Tools provided by WorkBuddy', tools }];
  }
  if (body.tool_choice !== undefined && body.tool_choice !== 'auto') fail('当前仅适配自动工具选择。');
  if (body.parallel_tool_calls !== undefined) {
    if (typeof body.parallel_tool_calls !== 'boolean') fail('parallel_tool_calls 应为布尔值。');
    request.parallel_tool_calls = body.parallel_tool_calls;
  }
  return request;
}

export async function* responsesToDsh(events) {
  const blocks = new Map();
  const indexFor = new Map();
  let nextIndex = 0;
  let terminal = false;
  let hasTools = false;
  function block(key, type, initial = {}) {
    if (!indexFor.has(key)) { indexFor.set(key, nextIndex++); blocks.set(key, { type, text: '', arguments: '', ...initial }); }
    return { index: indexFor.get(key), value: blocks.get(key) };
  }
  for await (const event of events) {
    if (terminal) throw new BridgeError('上游在完成后继续发送响应数据。', 502, 'stream_protocol_error');
    const oi = event.output_index ?? 0;
    if (event.type === 'response.output_text.delta' || event.type === 'response.reasoning_summary_text.delta') {
      if (typeof event.delta !== 'string') throw new BridgeError('上游文本增量格式错误。', 502);
      const type = event.type.includes('reasoning') ? 'reasoning' : 'text';
      const key = `${oi}:${event.content_index ?? event.summary_index ?? 0}:${type}`;
      const { index, value } = block(key, type);
      if (!value.started) { value.started = true; yield { type: 'block-start', index, blockType: type }; }
      value.text += event.delta;
      yield { type: type === 'text' ? 'text-delta' : 'reasoning-delta', index, text: event.delta };
    } else if (event.type === 'response.output_text.done') {
      const { index, value } = block(`${oi}:${event.content_index ?? 0}:text`, 'text');
      if (typeof event.text !== 'string' || !event.text.startsWith(value.text)) throw new BridgeError('上游完整文本与增量不一致。', 502);
      if (!value.started) { value.started = true; yield { type: 'block-start', index, blockType: 'text' }; }
      if (!value.closed) { value.text = event.text; value.closed = true; yield { type: 'block-end', index, block: { type: 'text', text: value.text } }; }
    } else if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
      const { index, value } = block(`tool:${oi}`, 'tool-call', { id: event.item.call_id, name: event.item.name });
      value.started = true; hasTools = true;
      yield { type: 'block-start', index, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index, id: value.id, name: value.name, argumentsDelta: '' };
    } else if (event.type === 'response.function_call_arguments.delta') {
      const { index, value } = block(`tool:${oi}`, 'tool-call');
      if (typeof event.delta !== 'string') throw new BridgeError('上游工具增量格式错误。', 502);
      value.arguments += event.delta;
      yield { type: 'tool-call-delta', index, id: value.id, name: value.name, argumentsDelta: event.delta };
    } else if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
      const item = event.item;
      const { index, value } = block(`tool:${oi}`, 'tool-call');
      if (!item.call_id || !item.name || typeof item.arguments !== 'string' || !item.arguments.startsWith(value.arguments)) throw new BridgeError('上游工具调用信息不一致。', 502);
      hasTools = true;
      Object.assign(value, { id: item.call_id, name: item.name, arguments: item.arguments, closed: true });
      yield { type: 'block-end', index, block: { type: 'tool-call', id: value.id, name: value.name, arguments: value.arguments } };
    } else if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) {
      terminal = true;
      const response = event.response ?? {};
      if (event.type === 'response.completed' && Array.isArray(response.output)) {
        for (const [outputIndex, item] of response.output.entries()) {
          if (item.type === 'message' && Array.isArray(item.content)) {
            for (const [contentIndex, part] of item.content.entries()) {
              const text = part.type === 'output_text' ? part.text : part.type === 'refusal' ? part.refusal : undefined;
              if (typeof text !== 'string') continue;
              const { index, value } = block(`${outputIndex}:${contentIndex}:text`, 'text');
              if (!text.startsWith(value.text)) throw new BridgeError('上游完成文本与增量不一致。', 502);
              if (!value.started) { value.started = true; yield { type: 'block-start', index, blockType: 'text' }; }
              if (!value.closed) { value.text = text; value.closed = true; yield { type: 'block-end', index, block: { type: 'text', text } }; }
            }
          } else if (item.type === 'function_call') {
            const { index, value } = block(`tool:${outputIndex}`, 'tool-call');
            if (value.closed) continue;
            if (!item.call_id || !item.name || typeof item.arguments !== 'string' || !item.arguments.startsWith(value.arguments)) throw new BridgeError('上游完成工具参数不一致。', 502);
            hasTools = true; Object.assign(value, { id: item.call_id, name: item.name, arguments: item.arguments, closed: true });
            yield { type: 'block-end', index, block: { type: 'tool-call', id: value.id, name: value.name, arguments: value.arguments } };
          }
        }
      }
      for (const [key, value] of blocks) {
        if (value.closed) continue;
        if (value.type === 'tool-call') {
          if (event.type === 'response.completed') throw new BridgeError('上游工具调用尚未完成。', 502);
          continue;
        }
        yield { type: 'block-end', index: indexFor.get(key), block: { type: value.type, text: value.text } };
      }
      const usage = response.usage;
      if (usage) yield { type: 'usage', usage: { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0, totalTokens: usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0), ...(usage.input_tokens_details?.cached_tokens === undefined ? {} : { cacheReadTokens: usage.input_tokens_details.cached_tokens }) } };
      if (event.type === 'response.failed') throw new BridgeError('OpenAI 响应失败，请检查账号权限或重新登录。', 502, 'upstream_error');
      if (event.type === 'response.incomplete' && response.incomplete_details?.reason !== 'max_output_tokens') throw new BridgeError('OpenAI 响应未完成。', 502, 'upstream_incomplete');
      yield { type: 'finish', reason: { kind: event.type === 'response.incomplete' ? 'max-tokens' : hasTools ? 'tool-calls' : 'stop' } };
    }
  }
  if (!terminal) throw new BridgeError('上游连接提前结束，未收到完成事件。', 502, 'stream_closed');
}

export function dshChatRequest(options) {
  return {
    model: options.model,
    messages: options.messages.map(message => {
      const content = message.content.filter(block => block.type === 'text').map(block => ({ type: 'text', text: block.text }));
      if (message.content.some(block => !['text', 'reasoning', 'tool-call'].includes(block.type))) fail('此模型桥接尚未接入附件或动态工具更新。');
      if (message.role === 'tool') return { role: 'tool', content, tool_call_id: message.toolCallId };
      const calls = message.content.filter(block => block.type === 'tool-call').map(block => ({ id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } }));
      return { role: message.role, content, ...(calls.length ? { tool_calls: calls } : {}) };
    }),
    ...(options.tools?.length ? { tools: options.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) } : {}),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.reasoningEffort === undefined ? {} : { reasoning_effort: options.reasoningEffort }),
  };
}
