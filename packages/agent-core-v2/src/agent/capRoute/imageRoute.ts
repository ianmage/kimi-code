import { createDecorator } from '#/_base/di/instantiation';
import type { AgentLLMRequestSource } from '#/agent/llmRequester/llmRequester';
import type { Message } from '#/llm-adapter/contract/message';
import type { ModelRequester } from '#/llm-adapter/model/model-requester';

export interface IAgentImageRouteService {
  readonly _serviceBrand: undefined;

  route(
    messages: readonly Message[],
    requester: ModelRequester,
    source: AgentLLMRequestSource | undefined,
    signal: AbortSignal | undefined,
  ): Promise<readonly Message[]>;
}

export const IAgentImageRouteService = createDecorator<IAgentImageRouteService>(
  'agentImageRouteService',
);
