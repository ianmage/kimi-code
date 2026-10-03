export const DEFAULT_WORKER_GRACE_MS = 5 * 60_000;

export interface WorkerStreamHandle {
  readonly workerId: string;
}

export interface WorkerRegistryOptions {
  now?: () => number;
  graceMs?: number;
  scanIntervalMs?: number;
  onLog?: (message: string) => void;
  onExpire?: (workerId: string) => void;
}

type Lease = { online: true; handle: WorkerStreamHandle } | { online: false; since: number };

export class WorkerRegistry {
  private readonly bindings = new Map<string, string>();
  private readonly leases = new Map<string, Lease>();
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly scanIntervalMs: number;
  private readonly onLog: (message: string) => void;
  private readonly onExpire: (workerId: string) => void;
  private scanTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: WorkerRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.graceMs = options.graceMs ?? DEFAULT_WORKER_GRACE_MS;
    this.scanIntervalMs = options.scanIntervalMs ?? DEFAULT_WORKER_GRACE_MS;
    this.onLog = options.onLog ?? (() => {});
    this.onExpire = options.onExpire ?? (() => {});
  }

  claim(workerId: string, tokenId: string): boolean {
    const owner = this.bindings.get(workerId);
    if (owner !== undefined && owner !== tokenId) {
      this.onLog(`claim rejected worker ${workerId}: owned by another token`);
      return false;
    }
    this.bindings.set(workerId, tokenId);
    return true;
  }

  authorize(workerId: string, tokenId: string): boolean {
    return this.bindings.get(workerId) === tokenId;
  }

  online(workerId: string): WorkerStreamHandle {
    const handle: WorkerStreamHandle = { workerId };
    this.leases.set(workerId, { online: true, handle });
    return handle;
  }

  offline(workerId: string, handle: WorkerStreamHandle): void {
    const lease = this.leases.get(workerId);
    if (lease === undefined || !lease.online || lease.handle !== handle) return;
    this.leases.set(workerId, { online: false, since: this.now() });
    this.scan();
  }

  unregister(workerId: string): void {
    this.bindings.delete(workerId);
    this.leases.delete(workerId);
  }

  revokeOwner(tokenId: string): void {
    for (const [workerId, owner] of this.bindings) {
      if (owner !== tokenId) continue;
      this.bindings.delete(workerId);
      this.leases.delete(workerId);
    }
  }

  restoreFrom(
    threads: readonly { hostWorkerId: string; ownerTokenId: string }[],
    receipts: readonly { workerId?: string }[] = [],
  ): void {
    const owners = new Map<string, Set<string>>();
    for (const thread of threads) {
      let ownersOfWorker = owners.get(thread.hostWorkerId);
      if (ownersOfWorker === undefined) {
        ownersOfWorker = new Set<string>();
        owners.set(thread.hostWorkerId, ownersOfWorker);
      }
      ownersOfWorker.add(thread.ownerTokenId);
    }
    for (const receipt of receipts) {
      if (receipt.workerId === undefined || owners.has(receipt.workerId)) continue;
      owners.set(receipt.workerId, new Set<string>());
    }
    const startupAt = this.now();
    for (const [workerId, ownersOfWorker] of owners) {
      this.leases.set(workerId, { online: false, since: startupAt });
      if (ownersOfWorker.size !== 1) {
        if (ownersOfWorker.size > 1) this.onLog(`binding not restored for worker ${workerId}: conflicting owners`);
        continue;
      }
      this.bindings.set(workerId, ownersOfWorker.values().next().value!);
    }
  }

  scan(): void {
    const now = this.now();
    for (const [workerId, lease] of this.leases) {
      if (lease.online) continue;
      if (now - lease.since < this.graceMs) continue;
      this.leases.delete(workerId);
      this.onExpire(workerId);
    }
  }

  startScan(intervalMs: number = this.scanIntervalMs): void {
    this.stopScan();
    this.scanTimer = setInterval(() => {
      this.scan();
    }, intervalMs);
    this.scanTimer.unref?.();
  }

  stopScan(): void {
    if (this.scanTimer === undefined) return;
    clearInterval(this.scanTimer);
    this.scanTimer = undefined;
  }

  isOnline(workerId: string): boolean {
    const lease = this.leases.get(workerId);
    return lease !== undefined && lease.online;
  }
}
