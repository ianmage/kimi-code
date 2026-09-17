export const VISION_DESCRIPTION_INSTRUCTION =
  'Describe each image in the user message for a text-only reader. If the message starts with a text part, treat it as the user intent and let it guide what matters in each image. Respond with exactly one labeled block per image, filling each block with a concise description of the corresponding image:\n';

const SLOT_BLOCK_RE = /<image-(\d+)>([\s\S]*?)<\/image-\1>/g;

export function visionSlotOutputTemplate(count: number): string {
  const blocks: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    blocks.push(`<image-${index}></image-${index}>`);
  }
  return blocks.join('\n');
}

export function parseSlots(text: string, count: number): (string | undefined)[] {
  const slots: (string | undefined)[] = Array.from<string | undefined>({ length: count }).fill(undefined);
  for (const match of text.matchAll(SLOT_BLOCK_RE)) {
    const label = Number(match[1]);
    if (!Number.isInteger(label) || label < 1 || label > count) continue;
    const description = match[2] ?? '';
    if (description.trim().length === 0) continue;
    if (slots[label - 1] !== undefined) continue;
    slots[label - 1] = description;
  }
  return slots;
}
