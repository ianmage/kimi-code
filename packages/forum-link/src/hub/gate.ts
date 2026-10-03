import type { IncomingMessage, ServerResponse } from 'node:http';

import { BROWSER_COOKIE_NAME } from '#/contract/browser';
import type { TokenRecord } from '#/contract/shared';

export interface GateOptions {
  lookup: (secret: string) => TokenRecord | undefined;
  adminKey?: string;
  trustedProxies?: readonly string[];
  maxFailures?: number;
  windowMs?: number;
  now?: () => number;
}

export type GateRole = TokenRecord['role'];

export type AuthFace = 'worker' | 'browser' | 'admin';

export type AuthenticateResult =
  | { ok: true; tokenId: string; role: GateRole }
  | { ok: false; status: 401 | 403 | 429 };

const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_WINDOW_MS = 60000;
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export class Gate {
  private readonly lookup: (secret: string) => TokenRecord | undefined;
  private readonly adminKey: string | undefined;
  private readonly trustedProxies: ReadonlySet<string>;
  readonly maxFailures: number;
  readonly windowMs: number;
  private readonly now: () => number;
  private readonly failures = new Map<string, { count: number; windowStart: number }>();
  private readonly connections = new Map<string, Set<ServerResponse>>();

  constructor(options: GateOptions) {
    this.lookup = options.lookup;
    this.adminKey = options.adminKey;
    this.trustedProxies = new Set(options.trustedProxies ?? []);
    this.maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = options.now ?? Date.now;
  }

  authenticate(req: IncomingMessage): AuthenticateResult {
    const ip = this.clientIp(req);
    if (this.currentFailures(ip) >= this.maxFailures) return { ok: false, status: 429 };
    const secret = bearerOf(req);
    if (secret === undefined) {
      this.recordFailure(ip);
      return { ok: false, status: 401 };
    }
    const record = this.lookup(secret);
    if (record === undefined) {
      this.recordFailure(ip);
      return { ok: false, status: 401 };
    }
    this.failures.delete(ip);
    return { ok: true, tokenId: record.tokenId, role: record.role };
  }

  requireRole(req: IncomingMessage, role: GateRole): AuthenticateResult {
    const result = this.authenticate(req);
    if (!result.ok) return result;
    if (result.role !== role) return { ok: false, status: 403 };
    return result;
  }

  authenticateCookie(req: IncomingMessage): AuthenticateResult {
    const ip = this.clientIp(req);
    if (this.currentFailures(ip) >= this.maxFailures) return { ok: false, status: 429 };
    const secret = cookieSecret(req);
    if (secret === undefined) return { ok: false, status: 401 };
    const record = this.lookup(secret);
    if (record === undefined || record.role !== 'device') {
      this.recordFailure(ip);
      return { ok: false, status: 401 };
    }
    this.failures.delete(ip);
    return { ok: true, tokenId: record.tokenId, role: record.role };
  }

  authorizeBrowser(req: IncomingMessage): AuthenticateResult {
    const bearer = this.authenticate(req);
    if (bearer.ok) {
      if (bearer.role !== 'device') return { ok: false, status: 403 };
      return bearer;
    }
    if (bearer.status === 429) return bearer;
    return this.authenticateCookie(req);
  }

  authorize(req: IncomingMessage, face: AuthFace): AuthenticateResult {
    if (face === 'worker') return this.requireRole(req, 'machine');
    if (face === 'browser') return this.authorizeBrowser(req);
    return this.authorizeAdmin(req);
  }

  clientIp(req: IncomingMessage): string {
    return this.resolveIp(req.socket.remoteAddress, req.headers['x-forwarded-for']);
  }

  noteAuthFailure(ip: string): void {
    this.recordFailure(ip);
  }

  isLimited(ip: string): boolean {
    return this.currentFailures(ip) >= this.maxFailures;
  }

  registerConnection(tokenId: string, res: ServerResponse): void {
    let registered = this.connections.get(tokenId);
    if (registered === undefined) {
      registered = new Set();
      this.connections.set(tokenId, registered);
    }
    registered.add(res);
    res.on('close', () => {
      this.unregisterConnection(tokenId, res);
    });
  }

  unregisterConnection(tokenId: string, res: ServerResponse): void {
    const registered = this.connections.get(tokenId);
    if (registered === undefined) return;
    registered.delete(res);
    if (registered.size === 0) this.connections.delete(tokenId);
  }

  closeAll(tokenId: string): void {
    const registered = this.connections.get(tokenId);
    if (registered === undefined) return;
    this.connections.delete(tokenId);
    for (const res of registered) res.destroy();
  }

  isLoopback(address: string | undefined): boolean {
    if (address === undefined) return false;
    return LOOPBACK_ADDRESSES.has(address) || address === 'localhost';
  }

  private authorizeAdmin(req: IncomingMessage): AuthenticateResult {
    const ip = this.clientIp(req);
    if (!this.isLoopback(ip)) return { ok: false, status: 403 };
    if (this.currentFailures(ip) >= this.maxFailures) return { ok: false, status: 429 };
    const secret = bearerOf(req);
    if (this.adminKey === undefined || secret === undefined || secret !== this.adminKey) {
      this.recordFailure(ip);
      return { ok: false, status: 401 };
    }
    this.failures.delete(ip);
    return { ok: true, tokenId: 'admin', role: 'machine' };
  }

  private resolveIp(socketAddress: string | undefined, forwardedFor: string | string[] | undefined): string {
    if (socketAddress !== undefined && !this.isTrusted(socketAddress)) return socketAddress;
    const headerValues = forwardedFor === undefined ? [] : Array.isArray(forwardedFor) ? forwardedFor : [forwardedFor];
    const candidates: string[] = [];
    for (const header of headerValues) {
      for (const raw of header.split(',')) {
        const value = raw.trim();
        if (value.length > 0) candidates.push(value);
      }
    }
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const candidate = candidates[i]!;
      if (!this.isTrusted(candidate)) return candidate;
    }
    return socketAddress ?? 'unknown';
  }

  private isTrusted(address: string): boolean {
    return this.trustedProxies.has(address) || this.isLoopback(address);
  }

  private currentFailures(source: string, at: number = this.now()): number {
    const record = this.failures.get(source);
    if (record === undefined) return 0;
    if (at - record.windowStart > this.windowMs) {
      this.failures.delete(source);
      return 0;
    }
    return record.count;
  }

  private recordFailure(source: string, at: number = this.now()): void {
    const record = this.failures.get(source);
    if (record === undefined || at - record.windowStart > this.windowMs) {
      this.failures.set(source, { count: 1, windowStart: at });
      return;
    }
    record.count += 1;
  }
}

function bearerOf(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (header === undefined) return undefined;
  const match = /^Bearer (.+)$/.exec(header);
  return match === null ? undefined : match[1];
}

export function cookieSecret(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() !== BROWSER_COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    if (value.length === 0) return undefined;
    return value;
  }
  return undefined;
}

