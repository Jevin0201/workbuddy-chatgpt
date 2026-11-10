import { BridgeError } from './errors.js';
import { responsesRequest, responsesToDsh } from './protocol.js';
import { parseAlias, selectModel } from './workbuddy.js';

export const PROVIDER = 'workbuddy-chatgpt';
export function createEngine({ api }) {
  return {
    async prepare(body, signal) {
      const alias = parseAlias(body.model);
      if (!alias) throw new BridgeError('请从 ChatGPT 账号目录选择模型。', 404, 'model_not_found');
      const model = selectModel(await api.models({ signal }), alias.id);
      const request = responsesRequest(body, model);
      return { chunks: () => responsesToDsh(api.streamResponses(request, { signal })) };
    },
  };
}
