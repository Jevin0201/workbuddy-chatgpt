import test from 'node:test';
import assert from 'node:assert/strict';
import { responsesRequest, responsesToDsh, dshChatRequest } from '../protocol.js';
import { CompletionState } from '../completion.js';
const model = { id: 'fixture-terra', reasoning: { efforts: [{ id: 'high', name: 'High' }] } };
const events = async function* (items) { yield* items; };
async function complete(items) { const state = new CompletionState('fixture-model'); for await (const chunk of responsesToDsh(events(items))) state.push(chunk); return state.result(); }

test('maps roles, tools, exact model ID and the actual selected effort', () => {
  const request = responsesRequest({ messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'question' }], reasoning_effort: 'high', tools: [{ type: 'function', function: { name: 'tool', parameters: { type: 'object', properties: {} } } }] }, model);
  assert.equal(request.model, 'fixture-terra'); assert.equal(request.store, false); assert.equal(request.stream, true);
  assert.equal(request.input[0].role, 'developer'); assert.equal(request.reasoning.effort, 'high'); assert.equal(request.tools[0].type, 'namespace');
  assert.throws(() => responsesRequest({ messages: [{ role: 'user', content: 'x' }], reasoning_effort: 'invented' }, model), /档位/);
});
test('tool history and DSH replay preserve tool arguments and call identities', () => {
  const body = dshChatRequest({ model: 'fixture-terra', messages: [{ role: 'assistant', content: [{ type: 'tool-call', id: 'call', name: 'tool', arguments: '{"x":1}' }] }, { role: 'tool', toolCallId: 'call', content: [{ type: 'text', text: 'result' }] }], reasoningEffort: 'high' });
  const request = responsesRequest(body, model); assert.equal(request.input[1].type, 'function_call_output'); assert.equal(request.input[1].call_id, 'call');
});
test('assembles text deltas once and handles completion-only responses', async () => {
  const response = { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } };
  const result = await complete([{ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Hel' }, { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'Hello' }, { type: 'response.completed', response }]);
  assert.equal(result.choices[0].message.content, 'Hello'); assert.equal(result.usage.total_tokens, 5);
  assert.equal((await complete([{ type: 'response.completed', response }])).choices[0].message.content, 'Hello');
});
test('assembles function calls without duplicate argument chunks', async () => {
  const item = { type: 'function_call', call_id: 'call', name: 'tool', arguments: '{"x":1}' };
  const result = await complete([{ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } }, { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"x":' }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { output: [item] } }]);
  assert.equal(result.choices[0].finish_reason, 'tool_calls'); assert.equal(result.choices[0].message.tool_calls[0].function.arguments, '{"x":1}');
});
test('rejects truncated, failed and inconsistent output instead of successful empty text', async () => {
  await assert.rejects(complete([{ type: 'response.output_text.delta', delta: 'x' }]), /提前结束/);
  await assert.rejects(complete([{ type: 'response.failed', response: {} }]), /响应失败/);
  await assert.rejects(complete([{ type: 'response.output_text.delta', delta: 'x' }, { type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'y' }] }] } }]), /不一致/);
});
