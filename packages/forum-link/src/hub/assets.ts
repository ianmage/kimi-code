import type { ServerResponse } from 'node:http';

import PAGE_HTML from '../page/index.html?raw';

export function servePage(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE_HTML);
}
