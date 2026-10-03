import { randomBytes, createHash } from 'node:crypto';

import type { TokenRecord, TokenRole } from '#/contract/shared';

export type TokenSummary = Omit<TokenRecord, 'hash'>;

export interface IssueResult {
  ok: true;
  tokenId: string;
  secret: string;
}

export type IssueError = { ok: false; reason: 'duplicate-name' | 'persist-failed'; error?: unknown };

export type RevokeResult = { ok: true } | { ok: false; error: unknown };

export interface TokensOptions {
  store: {
    records(): readonly TokenRecord[];
    save(next: readonly TokenRecord[]): Promise<void>;
  };
  random?: () => string;
  now?: () => number;
}

export class Tokens {
  private readonly store: TokensOptions['store'];
  private readonly random: () => string;
  private readonly now: () => number;
  private records: TokenRecord[];

  constructor(options: TokensOptions) {
    this.store = options.store;
    this.random = options.random ?? defaultRandom;
    this.now = options.now ?? Date.now;
    this.records = [...options.store.records()];
  }

  async issue(role: TokenRole, name: string): Promise<IssueResult | IssueError> {
    if (this.records.some((record) => record.role === role && record.name === name)) {
      return { ok: false, reason: 'duplicate-name' };
    }
    const tokenId = this.random();
    const secret = `${this.random()}${this.random()}`;
    const record: TokenRecord = {
      tokenId,
      name,
      role,
      hash: hashOf(secret),
      createdAt: this.now(),
    };
    const next = [...this.records, record];
    try {
      await this.store.save(next);
    } catch (error) {
      return { ok: false, reason: 'persist-failed', error };
    }
    this.records = next;
    return { ok: true, tokenId, secret };
  }

  lookup(secret: string): TokenRecord | undefined {
    const hash = hashOf(secret);
    return this.records.find((record) => record.hash === hash);
  }

  list(): readonly TokenSummary[] {
    return this.records.map(({ hash: _hash, ...rest }) => rest);
  }

  async revoke(tokenId: string): Promise<RevokeResult> {
    const next = this.records.filter((record) => record.tokenId !== tokenId);
    if (next.length === this.records.length) return { ok: true };
    try {
      await this.store.save(next);
    } catch (error) {
      return { ok: false, error };
    }
    this.records = next;
    return { ok: true };
  }
}

function hashOf(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function defaultRandom(): string {
  return randomBytes(24).toString('base64url');
}
