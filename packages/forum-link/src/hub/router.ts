import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';

import type { ActionFrame, Descriptor } from '#/contract/frames';
import { descriptorSchema, parseActionFrame, parseUplinkFrame } from '#/contract/frames';
import { servePage } from '#/hub/assets';
import { Gate } from '#/hub/gate';
import { Registry } from '#/hub/registry';

export interface HubServerOptions {
  password: string;
  bind?: string;
  maxFailures?: number;
  windowMs?: number;
  bufferSize?: number;
  livenessWindowMs?: number;
  heartbeatIntervalMs?: number;
  reapIntervalMs?: number;
}

export interface HubServer {
  server: Server;
  registry: Registry;
  gate: Gate;
  bind: string;
  close(): Promise<void>;
}

interface RouterTiming {
  heartbeatIntervalMs: number;
  reapIntervalMs: number;
}

interface RouterContext {
  registry: Registry;
  gate: Gate;
  timing: RouterTiming;
  subscribers: Map<string, Set<ServerResponse>>;
}

const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_WINDOW_MS = 60000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;
const DEFAULT_REAP_INTERVAL_MS = 5000;
const DEFAULT_BIND = '127.0.0.1';
const MAX_BODY_BYTES = 1024 * 1024;

const STREAM_PATH = /^\/api\/stream\/([^/]+)$/;
const SNAPSHOT_PATH = /^\/api\/threads\/([^/]+)\/snapshot$/;

function sendJson(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, JSON.stringify({ error: message }));
}

function bearerOf(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (header === undefined) return undefined;
  const match = /^Bearer (.+)$/.exec(header);
  return match === null ? undefined : match[1];
}

function sourceOf(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const piece = chunk as Buffer;
    size += piece.length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(piece);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function broadcast(ctx: RouterContext, threadId: string, payload: string): void {
  const set = ctx.subscribers.get(threadId);
  if (set === undefined) return;
  for (const res of set) res.write(payload);
}

function dropSubscriber(ctx: RouterContext, threadId: string, res: ServerResponse): void {
  const set = ctx.subscribers.get(threadId);
  if (set === undefined) return;
  set.delete(res);
  if (set.size === 0) ctx.subscribers.delete(threadId);
}

function closeSubscribers(ctx: RouterContext, threadId: string): void {
  const set = ctx.subscribers.get(threadId);
  if (set === undefined) return;
  for (const res of set) res.end();
  ctx.subscribers.delete(threadId);
}

function openStream(ctx: RouterContext, req: IncomingMessage, res: ServerResponse, threadId: string): void {
  if (ctx.registry.get(threadId) === undefined) {
    sendError(res, 404, 'unknown thread');
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  });
  res.flushHeaders();
  let set = ctx.subscribers.get(threadId);
  if (set === undefined) {
    set = new Set();
    ctx.subscribers.set(threadId, set);
  }
  set.add(res);
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, ctx.timing.heartbeatIntervalMs);
  let dropped = false;
  const drop = () => {
    if (dropped) return;
    dropped = true;
    clearInterval(heartbeat);
    dropSubscriber(ctx, threadId, res);
  };
  req.on('close', drop);
  res.on('close', drop);
}

function descriptorFrom(body: unknown): Descriptor | undefined {
  const parsed = descriptorSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

async function handleRegister(ctx: RouterContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendError(res, 400, 'invalid descriptor');
    return;
  }
  const descriptor = descriptorFrom(body);
  if (descriptor === undefined) {
    sendError(res, 400, 'invalid descriptor');
    return;
  }
  const thread = ctx.registry.create(descriptor);
  sendJson(res, 200, JSON.stringify({ id: thread.id }));
}

async function handleEntry(ctx: RouterContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const threadId = new URL(req.url ?? '/', 'http://hub.local').searchParams.get('target');
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendError(res, 400, 'invalid frame');
    return;
  }
  const parsed = parseUplinkFrame(body);
  if (!parsed.ok) {
    sendError(res, 400, 'invalid frame');
    return;
  }
  const frame = parsed.frame;
  const thread = threadId === null ? undefined : ctx.registry.get(threadId);
  if (thread === undefined) {
    sendError(res, 404, 'unknown thread');
    return;
  }
  if (frame.type === 'register') {
    thread.buffer.reset();
    thread.descriptor = { ...frame.descriptor };
    thread.touch();
    broadcast(ctx, thread.id, `data: ${JSON.stringify({ reset: true, descriptor: frame.descriptor })}\n\n`);
    sendJson(res, 200, JSON.stringify({ ok: true }));
    return;
  }
  if (frame.type === 'descriptor') {
    thread.descriptor = { ...frame.descriptor };
    thread.touch();
    broadcast(ctx, thread.id, `data: ${JSON.stringify({ descriptor: frame.descriptor })}\n\n`);
    sendJson(res, 200, JSON.stringify({ ok: true }));
    return;
  }
  const seq = thread.buffer.append(frame.entry);
  thread.touch();
  broadcast(ctx, thread.id, `data: ${JSON.stringify({ seq, entry: frame.entry })}\n\n`);
  sendJson(res, 200, JSON.stringify({ seq }));
}

async function handleAction(ctx: RouterContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendError(res, 400, 'invalid action');
    return;
  }
  const parsed = parseActionFrame(body);
  if (!parsed.ok) {
    sendError(res, 400, 'invalid action');
    return;
  }
  const frame: ActionFrame = parsed.frame;
  const thread = ctx.registry.get(frame.target);
  if (thread === undefined) {
    sendError(res, 404, 'unknown thread');
    return;
  }
  broadcast(ctx, thread.id, `data: ${JSON.stringify({ action: frame })}\n\n`);
  sendJson(res, 200, JSON.stringify({ ok: true }));
}

async function handleHeartbeat(ctx: RouterContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendError(res, 400, 'invalid heartbeat');
    return;
  }
  const target =
    typeof body === 'object' && body !== null && 'target' in body && typeof body.target === 'string'
      ? body.target
      : undefined;
  const thread = target === undefined ? undefined : ctx.registry.get(target);
  if (thread === undefined) {
    sendError(res, 404, 'unknown thread');
    return;
  }
  thread.touch();
  sendJson(res, 200, JSON.stringify({ ok: true }));
}

function handleSnapshot(ctx: RouterContext, res: ServerResponse, threadId: string): void {
  const thread = ctx.registry.get(threadId);
  if (thread === undefined) {
    sendError(res, 404, 'unknown thread');
    return;
  }
  const snapshot = thread.buffer.snapshot();
  sendJson(
    res,
    200,
    JSON.stringify({
      descriptor: thread.descriptor,
      entries: snapshot.entries,
      maxSeq: snapshot.maxSeq,
      openCards: snapshot.openCards,
    }),
  );
}

function handleThreads(ctx: RouterContext, res: ServerResponse): void {
  sendJson(res, 200, JSON.stringify({ threads: ctx.registry.list() }));
}

async function handleRequest(ctx: RouterContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://hub.local');
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (method === 'GET' && path === '/') {
    servePage(res);
    return;
  }
  const verdict = ctx.gate.check(sourceOf(req), bearerOf(req) ?? url.searchParams.get('key') ?? undefined);
  if (verdict === 'unauthorized') {
    sendError(res, 401, 'unauthorized');
    return;
  }
  if (verdict === 'rate-limited') {
    sendError(res, 429, 'rate limited');
    return;
  }
  if (method === 'GET' && path === '/api/threads') {
    handleThreads(ctx, res);
    return;
  }
  if (method === 'POST' && path === '/api/register') {
    await handleRegister(ctx, req, res);
    return;
  }
  if (method === 'POST' && path === '/api/entry') {
    await handleEntry(ctx, req, res);
    return;
  }
  if (method === 'POST' && path === '/api/action') {
    await handleAction(ctx, req, res);
    return;
  }
  if (method === 'POST' && path === '/api/heartbeat') {
    await handleHeartbeat(ctx, req, res);
    return;
  }
  if (method === 'GET') {
    const streamMatch = STREAM_PATH.exec(path);
    if (streamMatch !== null) {
      openStream(ctx, req, res, streamMatch[1]!);
      return;
    }
    const snapshotMatch = SNAPSHOT_PATH.exec(path);
    if (snapshotMatch !== null) {
      handleSnapshot(ctx, res, snapshotMatch[1]!);
      return;
    }
  }
  sendError(res, 404, 'not found');
}

export function createHubServer(options: HubServerOptions): HubServer {
  const bind = options.bind ?? DEFAULT_BIND;
  const gate = new Gate({
    password: options.password,
    maxFailures: options.maxFailures ?? DEFAULT_MAX_FAILURES,
    windowMs: options.windowMs ?? DEFAULT_WINDOW_MS,
  });
  const registry = new Registry({ bufferSize: options.bufferSize, livenessWindowMs: options.livenessWindowMs });
  const ctx: RouterContext = {
    registry,
    gate,
    timing: {
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      reapIntervalMs: options.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS,
    },
    subscribers: new Map(),
  };
  const server = createServer((req, res) => {
    void handleRequest(ctx, req, res).catch(() => {
      if (!res.headersSent) sendError(res, 400, 'bad request');
      else res.end();
    });
  });
  const reaper = setInterval(() => {
    for (const threadId of registry.reap(Date.now())) closeSubscribers(ctx, threadId);
  }, ctx.timing.reapIntervalMs);
  return {
    server,
    registry,
    gate,
    bind,
    close() {
      clearInterval(reaper);
      for (const threadId of ctx.subscribers.keys()) closeSubscribers(ctx, threadId);
      server.closeAllConnections();
      return new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
