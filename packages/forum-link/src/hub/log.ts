export function logLine(category: string, detail: string): void {
  process.stderr.write(`forum-link: ${category}: ${detail.replaceAll(/[\r\n]+/g, ' ')}\n`);
}
