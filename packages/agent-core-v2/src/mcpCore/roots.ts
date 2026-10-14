import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Root } from '@modelcontextprotocol/sdk/types.js';

export function deriveMcpRoots(directories: readonly string[]): Root[] {
  const roots: Root[] = [];
  const seen = new Set<string>();
  for (const directory of directories) {
    const uri = pathToFileURL(directory).href;
    if (seen.has(uri)) continue;
    seen.add(uri);
    const name = basename(directory);
    roots.push(name === '' ? { uri } : { uri, name });
  }
  return roots;
}