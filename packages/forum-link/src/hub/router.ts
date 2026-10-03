import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';

import {
  type OpPush,
  type RegisterResponse,
  parseUplinkBatch,
  parseWorkerReceiptReport,
  parseWorkerRegister,
  parseWorkerUnregister,
} from '#/contract/worker';
import {
  BROWSER_COOKIE_NAME,
  parseBrowserLoginRequest,
  parseBrowserOpsRequest,
} from '#/contract/browser';
import { parseAdminIssueRequest } from '#/contract/admin';
import { servePage } from '#/hub/assets';
import { Gate, type GateRole } from '#/hub/gate';
import { logLine } from '#/hub/log';
import { createNotifier } from '#/hub/notifier';
import { WorkerRegistry } from '#/hub/ownership';
import { HubState, type FanoutEvent, type State } from '#/hub/state';
import { Store } from '#/hub/store';
import { Tokens } from '#/hub/tokens';

export interface HubServerOptions {
  dataDir: string;
  bind?: string;
  port?: number;
  heartbeatIntervalMs?: number;
  trustedProxies?: readonly string[];
  maxFailures?: number;
  windowMs?: number;
  adminKey?: string;
  ntfyUrl?: string;
  ntfyTopic?: string;
  ntfyToken?: string;
  publicUrl?: string;
  workerGraceMs?: number;
  workerScanIntervalMs?: number;
  writeIntervalMs?: number;
}

export interface HubServer {
  server: Server;
  gate: Gate;
  state: State;
  tokens: Tokens;
  bind: string;
  close(): Promise<{ ok: boolean }>;
}

const DEFAULT_BIND = '127.0.0.1';
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

interface AuthContext {
  tokenId: string;
  role: GateRole;
}

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  match: RegExpMatchArray,
  auth: AuthContext,
) => void;

interface Route {
  method: string;
  pattern: RegExp;
  face: 'public' | 'login' | 'worker' | 'browser' | 'admin';
  handler: RouteHandler;
}

export class WorkerFace {
  private readonly streams = new Map<string, ServerResponse>();

  constructor(
    private readonly state: State,
    private readonly heartbeatIntervalMs: number,
    private readonly workerRegistry?: WorkerRegistry,
  ) {}

  openStream(workerId: string, res: ServerResponse): void {
    const previous = this.streams.get(workerId);
    this.streams.set(workerId, res);
    previous?.destroy();
    const handle = this.workerRegistry?.online(workerId);
    const timer = setInterval(() => {
      this.write(res, ': hb');
    }, this.heartbeatIntervalMs);
    timer.unref?.();
    res.on('close', () => {
      clearInterval(timer);
      if (handle !== undefined) this.workerRegistry?.offline(workerId, handle);
      if (this.streams.get(workerId) !== res) return;
      this.streams.delete(workerId);
      this.state.workerDisconnected(workerId);
    });
    this.state.workerConnected(workerId);
  }

  pushOp(workerId: string, push: OpPush): void {
    const res = this.streams.get(workerId);
    if (res === undefined) return;
    this.write(res, `event: op\ndata: ${JSON.stringify(push)}`);
  }

  closeWorker(workerId: string): void {
    this.streams.get(workerId)?.destroy();
  }

  private write(res: ServerResponse, text: string): void {
    try {
      res.write(`${text}\n\n`);
    } catch {
      res.destroy();
    }
  }
}

export class BrowserFace {
  private readonly streams = new Set<ServerResponse>();
  private listening = false;

  constructor(
    private readonly state: State,
    private readonly heartbeatIntervalMs: number,
  ) {}

  start(): void {
    if (this.listening) return;
    this.listening = true;
    this.state.onFanout((event) => {
      this.broadcast(event);
    });
  }

  openStream(res: ServerResponse): void {
    this.streams.add(res);
    const timer = setInterval(() => {
      this.write(res, ': hb');
    }, this.heartbeatIntervalMs);
    timer.unref?.();
    res.on('close', () => {
      clearInterval(timer);
      this.streams.delete(res);
    });
  }

  private broadcast(event: FanoutEvent): void {
    if (this.streams.size === 0) return;
    this.writeEvent(event.type, event);
  }

  private writeEvent(name: string, body: unknown): void {
    this.writeToAll(`event: ${name}\ndata: ${JSON.stringify(body)}`);
  }

  private writeToAll(text: string): void {
    for (const res of this.snapshotStreams()) this.write(res, text);
  }

  private snapshotStreams(): ServerResponse[] {
    return Array.from(this.streams);
  }

  private write(res: ServerResponse, text: string): void {
    try {
      res.write(`${text}\n\n`);
    } catch {
      this.streams.delete(res);
      res.destroy();
    }
  }
}

export interface RouterDeps {
  gate: Gate;
  state: State;
  tokens: Tokens;
  workers: WorkerFace;
  browsers: BrowserFace;
  workerRegistry: WorkerRegistry;
  heartbeatIntervalMs: number;
}

export function createRouterDeps(options: HubServerOptions): { deps: RouterDeps; store: Store } | { fatal: string } {
  const store = new Store({
    dataDir: options.dataDir,
    writeIntervalMs: options.writeIntervalMs,
    onWriteError: (error) => {
      logLine('store-write-failed', String(error));
    },
  });
  const loaded = store.load();
  if (!loaded.ok) return { fatal: loaded.error };
  let tokensCommitted = loaded.state.tokens;
  const stateView = () => {
    const view = state.persistView();
    return { tokens: tokensCommitted, threads: view.threads, receipts: view.receipts };
  };
  const tokens = new Tokens({
    store: {
      records: () => tokensCommitted,
      save: async (next) => {
        const result = await store.commitTokens(next);
        if (!result.ok) throw new Error('persist-failed');
        tokensCommitted = [...next];
      },
    },
  });
  store.bindPersistView(stateView);
  const gate = new Gate({
    lookup: (secret) => tokens.lookup(secret),
    adminKey: options.adminKey,
    trustedProxies: options.trustedProxies,
    maxFailures: options.maxFailures,
    windowMs: options.windowMs,
  });
  let workers: WorkerFace;
  let browsers: BrowserFace;
  const state = new HubState({
    deliver: (workerId, push) => {
      workers.pushOp(workerId, push);
    },
    tokenName: (tokenId) => tokens.list().find((record) => record.tokenId === tokenId)?.name,
    onLog: (message) => {
      logLine('register-rejected', message);
    },
    notifier: createNotifier({
      ntfyUrl: options.ntfyUrl,
      ntfyTopic: options.ntfyTopic,
      ntfyToken: options.ntfyToken,
      publicUrl: options.publicUrl,
    }),
  });
  state.restore({
    threads: loaded.state.threads,
    receipts: loaded.state.receipts,
  });
  const workerRegistry = new WorkerRegistry({
    graceMs: options.workerGraceMs,
    scanIntervalMs: options.workerScanIntervalMs,
    onLog: (message) => {
      logLine('register-rejected', message);
    },
    onExpire: (workerId) => {
      state.markWorkerReceiptsLost(workerId);
    },
  });
  workerRegistry.restoreFrom(loaded.state.threads, loaded.state.receipts);
  workerRegistry.startScan();
  state.onPersist(() => {
    store.requestWrite();
  });
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  workers = new WorkerFace(state, heartbeatIntervalMs, workerRegistry);
  browsers = new BrowserFace(state, heartbeatIntervalMs);
  browsers.start();
  return {
    store,
    deps: {
      gate,
      state,
      tokens,
      workers,
      browsers,
      workerRegistry,
      heartbeatIntervalMs,
    },
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('payload too large');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim().length === 0) return undefined;
  return JSON.parse(text);
}

async function rejectNonJson(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (hasJsonContentType(req)) return false;
  await new Promise<void>((resolve) => {
    req.resume();
    req.once('end', resolve);
    req.once('close', resolve);
  });
  sendError(res, 415, 'content-type must be application/json');
  return true;
}

function hasJsonContentType(req: IncomingMessage): boolean {
  const header = req.headers['content-type'];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return false;
  const semicolon = value.indexOf(';');
  const mime = (semicolon === -1 ? value : value.slice(0, semicolon)).trim().toLowerCase();
  return mime === 'application/json';
}

export function buildRoutes(deps: RouterDeps): Route[] {
  const route = (method: string, pattern: RegExp, face: Route['face'], handler: RouteHandler): Route => ({
    method,
    pattern,
    face,
    handler,
  });
  return [
    route('GET', /^\/$/, 'public', (_req, res) => {
      servePage(res);
    }),
    route('POST', /^\/api\/worker\/register$/, 'worker', (req, res, _match, auth) => {
      void handleWorkerRegister(deps, auth, req, res);
    }),
    route('GET', /^\/api\/worker\/stream$/, 'worker', (req, res, _match, auth) => {
      handleWorkerStream(deps, auth, req, res);
    }),
    route('POST', /^\/api\/worker\/batch$/, 'worker', (req, res, _match, auth) => {
      void handleWorkerBatch(deps, auth, req, res);
    }),
    route('POST', /^\/api\/worker\/receipt$/, 'worker', (req, res, _match, auth) => {
      void handleWorkerReceipt(deps, auth, req, res);
    }),
    route('POST', /^\/api\/worker\/unregister$/, 'worker', (req, res, _match, auth) => {
      void handleWorkerUnregister(deps, auth, req, res);
    }),
    route('POST', /^\/api\/browser\/login$/, 'login', (req, res) => {
      void handleBrowserLogin(deps, req, res);
    }),
    route('POST', /^\/api\/browser\/logout$/, 'browser', (_req, res) => {
      handleBrowserLogout(res);
    }),
    route('GET', /^\/api\/browser\/inbox$/, 'browser', (_req, res) => {
      handleBrowserInbox(deps, res);
    }),
    route('GET', /^\/api\/browser\/threads\/([^/]+)$/, 'browser', (_req, res, match) => {
      handleBrowserThread(deps, res, decodeURIComponent(match[1] ?? ''));
    }),
    route('GET', /^\/api\/browser\/stream$/, 'browser', (_req, res, _match, auth) => {
      handleBrowserStream(deps, auth, res);
    }),
    route('POST', /^\/api\/browser\/ops$/, 'browser', (req, res, _match, auth) => {
      void handleBrowserOps(deps, auth, req, res);
    }),
    route('DELETE', /^\/api\/browser\/threads\/([^/]+)$/, 'browser', (_req, res, match) => {
      void handleBrowserThreadDelete(deps, res, decodeURIComponent(match[1] ?? ''));
    }),
    route('GET', /^\/api\/browser\/devices$/, 'browser', (_req, res) => {
      handleBrowserDevices(deps, res);
    }),
    route('DELETE', /^\/api\/browser\/tokens\/([^/]+)$/, 'browser', (_req, res, match) => {
      void revokeToken(deps, res, decodeURIComponent(match[1] ?? ''));
    }),
    route('POST', /^\/api\/admin\/tokens$/, 'admin', (req, res) => {
      void handleAdminIssue(deps, req, res);
    }),
    route('GET', /^\/api\/admin\/tokens$/, 'admin', (_req, res) => {
      handleAdminList(deps, res);
    }),
    route('DELETE', /^\/api\/admin\/tokens\/([^/]+)$/, 'admin', (_req, res, match) => {
      void revokeToken(deps, res, decodeURIComponent(match[1] ?? ''));
    }),
  ];
}

async function handleWorkerRegister(
  deps: RouterDeps,
  auth: AuthContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const parsed = parseWorkerRegister(await readJsonBody(req));
  if (!parsed.ok) {
    sendError(res, 400, parsed.issues);
    return;
  }
  if (!deps.workerRegistry.claim(parsed.value.workerId, auth.tokenId)) {
    const response: RegisterResponse = {
      workerId: parsed.value.workerId,
      threads: parsed.value.threads.map((thread) => ({
        sessionId: thread.descriptor.sessionId,
        accepted: false,
      })),
    };
    sendJson(res, 200, response);
    return;
  }
  const response = deps.state.register(auth.tokenId, parsed.value.workerId, parsed.value);
  sendJson(res, 200, response);
}

function handleWorkerStream(deps: RouterDeps, auth: AuthContext, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://hub.local');
  const workerId = url.searchParams.get('workerId') ?? '';
  if (workerId.length === 0) {
    sendError(res, 400, 'workerId required');
    return;
  }
  if (!deps.workerRegistry.authorize(workerId, auth.tokenId)) {
    sendError(res, 404, 'not found');
    return;
  }
  deps.gate.registerConnection(auth.tokenId, res);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  deps.workers.openStream(workerId, res);
}

async function handleWorkerBatch(deps: RouterDeps, auth: AuthContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = parseUplinkBatch(await readJsonBody(req));
  if (!parsed.ok) {
    sendError(res, 400, parsed.issues);
    return;
  }
  if (!deps.workerRegistry.authorize(parsed.value.workerId, auth.tokenId)) {
    logLine('batch-gap', `resync required for worker ${parsed.value.workerId}`);
    sendError(res, 409, 'resync-required');
    return;
  }
  const result = deps.state.applyBatch(parsed.value.workerId, parsed.value);
  if (result.ok) {
    res.writeHead(200);
    res.end();
    return;
  }
  logLine('batch-gap', `resync required for worker ${parsed.value.workerId}`);
  sendError(res, 409, result.reason);
}

async function handleWorkerReceipt(deps: RouterDeps, auth: AuthContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = parseWorkerReceiptReport(await readJsonBody(req));
  if (!parsed.ok) {
    sendError(res, 400, parsed.issues);
    return;
  }
  if (deps.workerRegistry.authorize(parsed.value.workerId, auth.tokenId)) {
    for (const report of parsed.value.receipts) {
      deps.state.reportReceipt(parsed.value.workerId, report);
    }
  }
  res.writeHead(204);
  res.end();
}

async function handleWorkerUnregister(deps: RouterDeps, auth: AuthContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = parseWorkerUnregister(await readJsonBody(req));
  if (!parsed.ok) {
    sendError(res, 400, parsed.issues);
    return;
  }
  if (deps.workerRegistry.authorize(parsed.value.workerId, auth.tokenId)) {
    deps.workerRegistry.unregister(parsed.value.workerId);
    deps.workers.closeWorker(parsed.value.workerId);
    deps.state.unregister(parsed.value.workerId, parsed.value.finalReceipts);
  }
  res.writeHead(204);
  res.end();
}

async function handleBrowserLogin(deps: RouterDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (await rejectNonJson(req, res)) return;
  const ip = deps.gate.clientIp(req);
  const limited = deps.gate.isLimited(ip);
  const body = await readJsonBody(req);
  const parsed = parseBrowserLoginRequest(body);
  if (!limited && parsed.ok) {
    const record = deps.tokens.lookup(parsed.value.token);
    if (record !== undefined && record.role === 'device') {
      res.writeHead(204, {
        'set-cookie': `${BROWSER_COOKIE_NAME}=${parsed.value.token}; HttpOnly; Secure; SameSite=Strict; Path=/`,
      });
      res.end();
      return;
    }
  }
  deps.gate.noteAuthFailure(ip);
  sendError(res, limited ? 429 : 401, limited ? 'rate limited' : 'invalid token');
}

function handleBrowserLogout(res: ServerResponse): void {
  res.writeHead(204, {
    'set-cookie': `${BROWSER_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
  });
  res.end();
}

function handleBrowserInbox(deps: RouterDeps, res: ServerResponse): void {
  sendJson(res, 200, { threads: deps.state.inbox() });
}

function handleBrowserThread(deps: RouterDeps, res: ServerResponse, sessionId: string): void {
  const snapshot = deps.state.threadSnapshot(sessionId);
  if (snapshot === undefined) {
    sendError(res, 404, 'thread not found');
    return;
  }
  sendJson(res, 200, snapshot);
}

function handleBrowserStream(deps: RouterDeps, auth: AuthContext, res: ServerResponse): void {
  deps.gate.registerConnection(auth.tokenId, res);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  deps.browsers.openStream(res);
}

async function handleBrowserOps(
  deps: RouterDeps,
  auth: AuthContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (await rejectNonJson(req, res)) return;
  const parsed = parseBrowserOpsRequest(await readJsonBody(req));
  if (!parsed.ok) {
    sendError(res, 400, parsed.issues);
    return;
  }
  const receipt = deps.state.acceptOp(auth.tokenId, parsed.value.sessionId, parsed.value.intent);
  sendJson(res, 202, receipt);
}

async function handleBrowserThreadDelete(deps: RouterDeps, res: ServerResponse, sessionId: string): Promise<void> {
  const result = deps.state.removeOfflineThread(sessionId);
  if (result.ok) {
    res.writeHead(204);
    res.end();
    return;
  }
  sendError(res, 409, result.reason);
}

function handleBrowserDevices(deps: RouterDeps, res: ServerResponse): void {
  sendJson(res, 200, deps.tokens.list());
}

async function handleAdminIssue(deps: RouterDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (await rejectNonJson(req, res)) return;
  const parsed = parseAdminIssueRequest(await readJsonBody(req));
  if (!parsed.ok) {
    sendError(res, 400, parsed.issues);
    return;
  }
  const result = await deps.tokens.issue(parsed.value.role, parsed.value.name);
  if (result.ok) {
    sendJson(res, 200, { tokenId: result.tokenId, secret: result.secret });
    return;
  }
  sendError(res, result.reason === 'duplicate-name' ? 409 : 500, result.reason);
}

function handleAdminList(deps: RouterDeps, res: ServerResponse): void {
  sendJson(res, 200, deps.tokens.list());
}

async function revokeToken(deps: RouterDeps, res: ServerResponse, tokenId: string): Promise<void> {
  const record = deps.tokens.list().find((entry) => entry.tokenId === tokenId);
  const result = await deps.tokens.revoke(tokenId);
  if (!result.ok) {
    sendError(res, 500, 'revoke failed');
    return;
  }
  deps.gate.closeAll(tokenId);
  if (record?.role === 'machine') {
    deps.state.dropOwner(tokenId);
    deps.workerRegistry.revokeOwner(tokenId);
  }
  res.writeHead(204);
  res.end();
}

async function handleRequest(routes: Route[], deps: RouterDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://hub.local');
  const method = (req.method ?? 'GET').toUpperCase();
  if (hasQueryCredential(url)) {
    sendError(res, 401, 'credentials are not accepted in the query string');
    return;
  }
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(url.pathname);
    if (match === null) continue;
    if (route.face === 'public' || route.face === 'login') {
      route.handler(req, res, match, { tokenId: '', role: 'machine' });
      return;
    }
    const verdict = deps.gate.authorize(req, route.face);
    if (!verdict.ok) {
      sendError(res, verdict.status, verdict.status === 429 ? 'rate limited' : 'unauthorized');
      return;
    }
    route.handler(req, res, match, { tokenId: verdict.tokenId, role: verdict.role });
    return;
  }
  sendError(res, 404, 'not found');
}

function hasQueryCredential(url: URL): boolean {
  return url.searchParams.has('key') || url.searchParams.has('token');
}

export function createHubServer(options: HubServerOptions): HubServer {
  const bind = options.bind ?? DEFAULT_BIND;
  const router = createRouterDeps(options);
  if ('fatal' in router) throw new Error(router.fatal);
  const { deps, store } = router;
  const routes = buildRoutes(deps);
  const server = createServer((req, res) => {
    void handleRequest(routes, deps, req, res).catch(() => {
      if (!res.headersSent) sendError(res, 400, 'bad request');
      else res.end();
    });
  });
  return {
    server,
    gate: deps.gate,
    state: deps.state,
    tokens: deps.tokens,
    bind,
    async close() {
      deps.workerRegistry.stopScan();
      server.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      try {
        await store.flush();
        return { ok: true };
      } catch (error) {
        logLine('store-write-failed', String(error));
        return { ok: false };
      }
    },
  };
}
