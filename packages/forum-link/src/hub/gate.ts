import { createHash, timingSafeEqual } from 'node:crypto';

export interface GateOptions {
  password: string;
  maxFailures?: number;
  windowMs?: number;
}

export type GateVerdict = 'ok' | 'unauthorized' | 'rate-limited';

export interface StartupBannerOptions {
  password: string;
  maxFailures: number;
  windowMs: number;
}

const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_WINDOW_MS = 60000;

export class Gate {
  private readonly password: string;
  readonly maxFailures: number;
  readonly windowMs: number;
  private readonly failures = new Map<string, { count: number; windowStart: number }>();

  constructor(options: GateOptions) {
    this.password = options.password;
    this.maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  }

  get isOpen(): boolean {
    return this.password.length === 0;
  }

  check(source: string, presented: string | undefined, now: number = Date.now()): GateVerdict {
    if (this.isOpen) return 'ok';
    if (this.currentFailures(source, now) >= this.maxFailures) return 'rate-limited';
    if (presented === undefined || !this.passwordMatches(presented)) {
      this.recordFailure(source, now);
      return 'unauthorized';
    }
    this.failures.delete(source);
    return 'ok';
  }

  noteSuccess(source: string): void {
    this.failures.delete(source);
  }

  private passwordMatches(presented: string): boolean {
    const expected = createHash('sha256').update(this.password).digest();
    const actual = createHash('sha256').update(presented).digest();
    return timingSafeEqual(expected, actual);
  }

  private currentFailures(source: string, now: number): number {
    const record = this.failures.get(source);
    if (record === undefined) return 0;
    if (now - record.windowStart > this.windowMs) {
      this.failures.delete(source);
      return 0;
    }
    return record.count;
  }

  private recordFailure(source: string, now: number): void {
    const record = this.failures.get(source);
    if (record === undefined || now - record.windowStart > this.windowMs) {
      this.failures.set(source, { count: 1, windowStart: now });
      return;
    }
    record.count += 1;
  }
}

export function formatStartupBanner(options: StartupBannerOptions): string {
  const rateLimit = `rate limit: ${options.maxFailures} failures per ${options.windowMs}ms per source`;
  if (options.password.length === 0) {
    return [
      'WARNING: Forum Link hub is running in OPEN mode (no password).',
      'Anyone who can reach this port can read the projected session and execute all six actions (approve/deny/answer/send/pause/end-session).',
      'Set a password with --password <secret> or the password file before exposing this hub.',
      rateLimit,
    ].join('\n');
  }
  return ['auth: password required', rateLimit].join('\n');
}
