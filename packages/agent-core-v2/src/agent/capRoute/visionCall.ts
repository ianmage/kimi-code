import { isAbortError } from '#/_base/utils/abort';
import type { RoutableImage } from '#/agent/capRoute/injector';
import { isUnauthorizedLlmError, llmMessageFromError } from '#/llm-adapter/contract/errors';
import type { ContentPart, Message } from '#/llm-adapter/contract/message';
import { runWithCredentialRecovery } from '#/llm-adapter/model/credential-recovery';
import type { ModelRequester } from '#/llm-adapter/model/model-requester';
import type { TokenUsage } from '#human/llm/usage';

import { VISION_DESCRIPTION_INSTRUCTION, visionSlotOutputTemplate } from './slotParser';

const INTENT_ANCHOR_MAX_CHARS = 2000;
const INTENT_ANCHOR_ELLIPSIS = '...';

export class VisionCallError extends Error {
  constructor(cause: unknown) {
    super('image route vision call failed');
    this.name = 'VisionCallError';
    this.cause = cause;
  }
}

export function buildIntentAnchor(messages: readonly Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    const text = message.content
      .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('');
    if (text.length === 0) continue;
    return truncateAnchor(text);
  }
  return undefined;
}

function truncateAnchor(text: string): string {
  if (text.length <= INTENT_ANCHOR_MAX_CHARS) return text;
  return `${text.slice(0, INTENT_ANCHOR_MAX_CHARS - INTENT_ANCHOR_ELLIPSIS.length)}${INTENT_ANCHOR_ELLIPSIS}`;
}

export async function describeImages(
  requester: ModelRequester,
  images: readonly (RoutableImage & { visionPart: ContentPart })[],
  intentAnchor: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ text: string; usage?: TokenUsage }> {
  const content: ContentPart[] = [];
  if (intentAnchor !== undefined) content.push({ type: 'text', text: intentAnchor });
  for (const image of images) content.push(image.visionPart);
  const input = {
    systemPrompt: `${VISION_DESCRIPTION_INSTRUCTION}${visionSlotOutputTemplate(images.length)}`,
    tools: [],
    messages: [{ role: 'user', content, toolCalls: [] }] satisfies Message[],
  };
  const consume = async (): Promise<{ text: string; usage?: TokenUsage }> => {
    let text = '';
    let usage: TokenUsage | undefined;
    for await (const event of requester.request(input, signal, undefined)) {
      if (event.type === 'part' && event.part.type === 'text') {
        text += event.part.text;
      } else if (event.type === 'usage') {
        usage = event.usage;
      }
    }
    if (text.trim().length === 0) throw new VisionCallError(new Error('empty vision response'));
    return { text, usage };
  };
  try {
    return await runWithCredentialRecovery(requester.model.credentials, consume, signal);
  } catch (error) {
    if (error instanceof VisionCallError) throw error;
    if (isAbortError(error)) throw error;
    if (isUnauthorizedLlmError(error) || isUnauthorizedLlmError(llmMessageFromError(error))) {
      throw error;
    }
    throw new VisionCallError(error);
  }
}
