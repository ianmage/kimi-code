import { buildMediaPathTag } from '#/agent/media/mediaRef';
import type { ContentPart, Message } from '#/llm-adapter/contract/message';

export interface RoutableImage {
  readonly messageIndex: number;
  readonly partIndex: number;
  readonly identity: string;
  readonly displayPath?: string;
  readonly part: ContentPart;
}

function injectedTextPart(image: RoutableImage, description: string): ContentPart {
  const tag =
    image.displayPath === undefined
      ? '<image></image>'
      : buildMediaPathTag('image', image.displayPath);
  return { type: 'text', text: `${tag}${description}` };
}

function described(
  descriptions: ReadonlyMap<string, string>,
  identity: string,
): string | undefined {
  const text = descriptions.get(identity);
  if (text === undefined || text.trim().length === 0) return undefined;
  return text;
}

export function injectDescriptions(
  messages: readonly Message[],
  images: readonly RoutableImage[],
  descriptions: ReadonlyMap<string, string>,
): readonly Message[] {
  const replacements = new Map<number, Map<number, ContentPart>>();
  for (const image of images) {
    const description = described(descriptions, image.identity);
    if (description === undefined) continue;
    let byPart = replacements.get(image.messageIndex);
    if (byPart === undefined) {
      byPart = new Map();
      replacements.set(image.messageIndex, byPart);
    }
    byPart.set(image.partIndex, injectedTextPart(image, description));
  }
  if (replacements.size === 0) return messages;
  return messages.map((message, messageIndex) => {
    const byPart = replacements.get(messageIndex);
    if (byPart === undefined) return message;
    return {
      ...message,
      content: message.content.map((part, partIndex) => byPart.get(partIndex) ?? part),
    };
  });
}
