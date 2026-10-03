import {
  parseOpIntent,
  type OpIntent,
  type ReceiptReport,
  type TimelineEntry,
  type UplinkBatch,
  type UplinkFrame,
  type WorkerReceiptReport,
  type WorkerSnapshot,
  type WorkerUnregister,
} from '@moonshot-ai/forum-link';

export type LinkState = 'detached' | 'connecting' | 'published' | 'backoff';

export interface LinkTiming {
  readonly heartbeatTimeoutMs?: number;
  readonly backoffBaseMs?: number;
  readonly backoffCapMs?: number;
  readonly batchIntervalMs?: number;
}

export interface DownlinkOp {
  readonly opId: string;
  readonly sessionId: string;
  readonly intent: OpIntent;
}

export interface LinkOptions {
  readonly url: string;
  readonly token: string;
  readonly getSnapshot: () => Omit<WorkerSnapshot, 'recentReceipts'>;
  readonly onOp: (op: DownlinkOp) => void;
  readonly onFatal?: (message: string) => void;
  readonly onStateChange?: (state: LinkState) => void;
  readonly timing?: LinkTiming;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly ledgerLimit?: number;
}

export interface SseMessage {
  readonly event?: string;
  readonly data: string;
}

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 60000;
const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_CAP_MS = 30000;
const DEFAULT_BATCH_INTERVAL_MS = 200;
const DEFAULT_LEDGER_LIMIT = 200;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_BACKOFF_EXPONENT = 16;

const DEFAULT_TIMING: Required<LinkTiming> = {
  heartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
  backoffBaseMs: DEFAULT_BACKOFF_BASE_MS,
  backoffCapMs: DEFAULT_BACKOFF_CAP_MS,
  batchIntervalMs: DEFAULT_BATCH_INTERVAL_MS,
};

function normalizeTiming(timing: LinkTiming | undefined): Required<LinkTiming> {
  if (timing === undefined) return { ...DEFAULT_TIMING };
  return {
    heartbeatTimeoutMs: timing.heartbeatTimeoutMs ?? DEFAULT_TIMING.heartbeatTimeoutMs,
    backoffBaseMs: timing.backoffBaseMs ?? DEFAULT_TIMING.backoffBaseMs,
    backoffCapMs: timing.backoffCapMs ?? DEFAULT_TIMING.backoffCapMs,
    batchIntervalMs: timing.batchIntervalMs ?? DEFAULT_TIMING.batchIntervalMs,
  };
}

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  onComment?: () => void,
): AsyncGenerator<SseMessage, void, void> {
  const reader = stream.getReader();
  try {
    yield* parseSseReader(reader, onComment);
  } finally {
    reader.releaseLock();
  }
}

async function* parseSseReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onComment?: () => void,
): AsyncGenerator<SseMessage, void, void> {
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replaceAll('\r\n', '\n');
    for (;;) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary < 0) break;
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const message = parseSseBlock(block, onComment);
      if (message !== undefined) yield message;
    }
  }
  buffer += decoder.decode();
  const message = parseSseBlock(buffer, onComment);
  if (message !== undefined) yield message;
}

function parseSseBlock(block: string, onComment?: () => void): SseMessage | undefined {
  let event: string | undefined;
  const dataLines: string[] = [];
  let sawComment = false;
  let sawField = false;
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) {
      sawComment = true;
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const rawValue = colon < 0 ? '' : line.slice(colon + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
    if (field === '') continue;
    sawField = true;
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') event = value;
  }
  if (sawComment) onComment?.();
  if (!sawField) return undefined;
  return { event, data: dataLines.join('\n') };
}

function timelineTail(entries: TimelineEntry[]): number {
  return entries.length > 0 ? entries.at(-1)!.seq : 0;
}

function mergeFrameLists(current: UplinkFrame[], addend: UplinkFrame[]): UplinkFrame[] {
  const merged = [...current];
  for (const frame of addend) {
    if (frame.kind === 'overview') {
      const index = merged.findIndex(
        (queued) => queued.kind === 'overview' && queued.sessionId === frame.sessionId,
      );
      if (index >= 0) {
        merged[index] = frame;
        continue;
      }
    }
    if (frame.kind === 'timeline') {
      const index = merged.findIndex(
        (queued) => queued.kind === 'timeline' && queued.sessionId === frame.sessionId,
      );
      if (index >= 0) {
        const queued = merged[index] as Extract<UplinkFrame, { kind: 'timeline' }>;
        merged[index] = { ...queued, entries: [...queued.entries, ...frame.entries] };
        continue;
      }
    }
    merged.push(frame);
  }
  return merged;
}

function mergeReplayFrames(snapshot: WorkerSnapshot, replay: UplinkFrame[]): WorkerSnapshot {
  const framesBySession = new Map<string, UplinkFrame[]>();
  for (const frame of replay) {
    const list = framesBySession.get(frame.sessionId);
    if (list === undefined) framesBySession.set(frame.sessionId, [frame]);
    else list.push(frame);
  }
  const threads = snapshot.threads.map((thread) => {
    const frames = framesBySession.get(thread.descriptor.sessionId);
    if (frames === undefined) return thread;
    let overview = thread.overview;
    let descriptor = thread.descriptor;
    let timeline = thread.timeline;
    for (const frame of frames) {
      if (frame.kind === 'overview') overview = frame.overview;
      else if (frame.kind === 'descriptor') descriptor = frame.descriptor;
      else {
        const tail = timelineTail(timeline);
        const fresh = frame.entries.filter((entry) => entry.seq > tail);
        timeline = [...timeline, ...fresh];
      }
    }
    return { descriptor, overview, timeline, openCards: thread.openCards };
  });
  return { ...snapshot, threads };
}

function pruneQueueAgainstSnapshot(queue: UplinkFrame[], snapshot: WorkerSnapshot): UplinkFrame[] {
  const tails = new Map<string, number>();
  for (const thread of snapshot.threads) {
    tails.set(thread.descriptor.sessionId, timelineTail(thread.timeline));
  }
  const pruned: UplinkFrame[] = [];
  for (const frame of queue) {
    if (frame.kind !== 'timeline') {
      pruned.push(frame);
      continue;
    }
    const tail = tails.get(frame.sessionId) ?? 0;
    const fresh = frame.entries.filter((entry) => entry.seq > tail);
    if (fresh.length > 0) pruned.push({ ...frame, entries: fresh });
  }
  return pruned;
}

interface LedgerEntry {
  readonly report: ReceiptReport;
  sent: boolean;
}

export class Link {
  private currentState: LinkState = 'detached';
  private active = false;
  private generation = 0;
  private attempt = 0;
  private workerId: string | undefined;
  private readonly timing: Required<LinkTiming>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ledgerLimit: number;
  private readonly ledger = new Map<string, LedgerEntry>();
  private readonly queue: UplinkFrame[] = [];
  private pendingReplay: UplinkFrame[] = [];
  private batchInFlight = false;
  private receiptInFlight = false;
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private backoffTimer: ReturnType<typeof setTimeout> | undefined;
  private backoffResolve: (() => void) | undefined;
  private streamAbort: AbortController | undefined;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private lastReceivedAt = 0;

  constructor(private readonly options: LinkOptions) {
    this.timing = normalizeTiming(options.timing);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.ledgerLimit = options.ledgerLimit ?? DEFAULT_LEDGER_LIMIT;
  }

  get state(): LinkState {
    return this.currentState;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.pendingReplay = [];
    this.generation += 1;
    void this.connectionLoop(this.generation);
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    this.generation += 1;
    this.clearTimers();
    this.streamAbort?.abort();
    await this.unregister();
    this.ledger.clear();
    this.queue.length = 0;
    this.pendingReplay = [];
    this.batchInFlight = false;
    this.setState('detached');
  }

  enqueue(frame: UplinkFrame): void {
    if (!this.active) return;
    if (frame.kind === 'overview') {
      const index = this.queue.findIndex(
        (queued) => queued.kind === 'overview' && queued.sessionId === frame.sessionId,
      );
      if (index >= 0) this.queue.splice(index, 1);
    }
    if (frame.kind === 'timeline') {
      const index = this.queue.findIndex(
        (queued) => queued.kind === 'timeline' && queued.sessionId === frame.sessionId,
      );
      if (index >= 0) {
        const queued = this.queue[index] as Extract<UplinkFrame, { kind: 'timeline' }>;
        this.queue[index] = { ...queued, entries: [...queued.entries, ...frame.entries] };
        return;
      }
    }
    this.queue.push(frame);
    this.scheduleFlush();
  }

  resync(): void {
    if (!this.active) return;
    this.generation += 1;
    this.queue.length = 0;
    this.clearTimers();
    this.streamAbort?.abort();
    this.attempt = 0;
    void this.connectionLoop(this.generation);
  }

  reportReceipt(report: ReceiptReport): void {
    this.ledger.delete(report.opId);
    this.ledger.set(report.opId, { report, sent: false });
    while (this.ledger.size > this.ledgerLimit) {
      const oldest = this.ledger.keys().next();
      if (oldest.done === true) break;
      this.ledger.delete(oldest.value);
    }
    if (this.currentState === 'published') void this.flushReceipts();
  }

  pendingReceipts(): ReceiptReport[] {
    return [...this.ledger.values()]
      .filter((entry) => !entry.sent)
      .map((entry) => entry.report);
  }

  private snapshotForRegister(): WorkerSnapshot {
    const snapshot: WorkerSnapshot = {
      ...this.options.getSnapshot(),
      recentReceipts: [...this.ledger.values()].map((entry) => entry.report),
    };
    if (this.pendingReplay.length === 0) return snapshot;
    return mergeReplayFrames(snapshot, this.pendingReplay);
  }

  private async connectionLoop(generation: number): Promise<void> {
    for (;;) {
      if (this.generation !== generation) return;
      this.setState('connecting');
      const cycle = await this.connectOnce(generation);
      if (this.generation !== generation) return;
      if (cycle.kind === 'stale' || cycle.kind === 'fatal') return;
      if (cycle.kind === 'retry') {
        this.attempt += 1;
        this.setState('backoff');
        await this.waitBackoff(this.backoffDelayMs());
        continue;
      }
      this.attempt = 0;
      this.setState('published');
      this.scheduleFlush();
      void this.flushReceipts();
      const outcome = await this.consumeStream(cycle.stream, generation);
      if (this.generation !== generation) return;
      if (outcome === 'stale') return;
      this.attempt += 1;
      this.setState('backoff');
      await this.waitBackoff(this.backoffDelayMs());
    }
  }

  private async connectOnce(generation: number): Promise<ConnectOutcome> {
    const snapshot = this.snapshotForRegister();
    this.workerId = snapshot.workerId;
    const prunedQueue = pruneQueueAgainstSnapshot(this.queue, snapshot);
    this.queue.length = 0;
    this.queue.push(...prunedQueue);
    const registered = await this.postJson(
      '/api/worker/register',
      JSON.stringify(snapshot),
      generation,
    );
    if (registered === undefined) return { kind: 'retry' };
    if (registered.kind === 'stale') return { kind: 'stale' };
    if (registered.kind === 'fatal') return { kind: 'fatal' };
    this.drain(registered.response);
    if (registered.response.status !== 200) return { kind: 'retry' };
    this.pendingReplay = [];
    const stream = await this.openStream(generation);
    if (stream.kind === 'ok') return { kind: 'published', stream: stream.body };
    if (stream.kind === 'retry') return { kind: 'retry' };
    if (stream.kind === 'fatal') return { kind: 'fatal' };
    return { kind: 'stale' };
  }

  private async openStream(generation: number): Promise<StreamOpenResult> {
    const workerId = this.workerId;
    if (workerId === undefined) return { kind: 'retry' };
    this.streamAbort = new AbortController();
    this.lastReceivedAt = this.now();
    this.armSilenceTimer(generation);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.options.url}/api/worker/stream?workerId=${encodeURIComponent(workerId)}`,
        {
          headers: { accept: 'text/event-stream', authorization: `Bearer ${this.options.token}` },
          signal: this.streamAbort.signal,
        },
      );
    } catch {
      this.clearSilenceTimer();
      return { kind: 'retry' };
    }
    if (this.generation !== generation) {
      this.clearSilenceTimer();
      this.drain(response);
      return { kind: 'stale' };
    }
    if (response.status === 401) {
      this.clearSilenceTimer();
      this.drain(response);
      this.fatal('forum link: hub rejected the machine token (401)');
      return { kind: 'fatal' };
    }
    if (!response.ok || response.body === null) {
      this.clearSilenceTimer();
      this.drain(response);
      return { kind: 'retry' };
    }
    return { kind: 'ok', body: response.body };
  }

  private async consumeStream(
    body: ReadableStream<Uint8Array>,
    generation: number,
  ): Promise<StreamOutcome> {
    try {
      for await (const message of parseSseStream(body, () => {
        this.touchSilence(generation);
      })) {
        this.touchSilence(generation);
        if (this.generation !== generation) return 'stale';
        this.dispatchMessage(message);
      }
    } catch {
      return this.streamOutcome(generation);
    } finally {
      this.clearSilenceTimer();
    }
    return this.streamOutcome(generation);
  }

  private streamOutcome(generation: number): StreamOutcome {
    return this.generation === generation ? 'stream-end' : 'stale';
  }

  private dispatchMessage(message: SseMessage): void {
    if (message.event !== 'op') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.data);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const push = parsed as { opId?: unknown; sessionId?: unknown; intent?: unknown };
    if (typeof push.opId !== 'string' || typeof push.sessionId !== 'string') return;
    const intent = parseOpIntent(push.intent);
    if (!intent.ok) return;
    this.options.onOp({ opId: push.opId, sessionId: push.sessionId, intent: intent.value });
  }

  private scheduleFlush(): void {
    if (this.batchTimer !== undefined || this.batchInFlight) return;
    if (this.currentState !== 'published' || this.queue.length === 0) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined;
      void this.flushBatch();
    }, this.timing.batchIntervalMs);
  }

  private async flushBatch(): Promise<void> {
    if (this.batchInFlight || this.currentState !== 'published') return;
    if (this.queue.length === 0) return;
    const workerId = this.workerId;
    if (workerId === undefined) return;
    const frames = this.queue.splice(0);
    this.batchInFlight = true;
    const generation = this.generation;
    let response: PostResult | undefined;
    try {
      response = await this.postJson(
        '/api/worker/batch',
        JSON.stringify({ workerId, frames } satisfies UplinkBatch),
        generation,
      );
    } finally {
      this.batchInFlight = false;
    }
    if (response === undefined) {
      this.replay(frames);
      this.recoverFromBatchFailure();
      return;
    }
    if (response.kind === 'stale') {
      this.replay(frames);
      return;
    }
    if (response.kind === 'fatal') {
      this.replay(frames);
      return;
    }
    if (response.response.status === 200) {
      this.scheduleFlush();
      return;
    }
    this.replay(frames);
    if (response.response.status === 409) {
      this.resync();
      return;
    }
    this.recoverFromBatchFailure();
  }

  private replay(frames: UplinkFrame[]): void {
    this.pendingReplay = mergeFrameLists(this.pendingReplay, frames);
  }

  private recoverFromBatchFailure(): void {
    if (!this.active) return;
    this.generation += 1;
    this.queue.length = 0;
    this.clearTimers();
    this.streamAbort?.abort();
    this.attempt += 1;
    this.setState('backoff');
    const generation = this.generation;
    void (async () => {
      await this.waitBackoff(this.backoffDelayMs());
      if (this.generation !== generation) return;
      await this.connectionLoop(generation);
    })();
  }

  private async flushReceipts(): Promise<void> {
    if (this.receiptInFlight) return;
    this.receiptInFlight = true;
    try {
      for (;;) {
        if (this.currentState !== 'published') return;
        const workerId = this.workerId;
        if (workerId === undefined) return;
        const pending = [...this.ledger.values()].filter((entry) => !entry.sent);
        if (pending.length === 0) return;
        const response = await this.postJson(
          '/api/worker/receipt',
          JSON.stringify({
            workerId,
            receipts: pending.map((entry) => entry.report),
          } satisfies WorkerReceiptReport),
          this.generation,
        );
        if (response === undefined || response.kind !== 'ok') return;
        if (response.response.status !== 204) return;
        for (const entry of pending) entry.sent = true;
      }
    } finally {
      this.receiptInFlight = false;
    }
  }

  private async unregister(): Promise<void> {
    const workerId = this.workerId;
    if (workerId === undefined) return;
    const finalReceipts = [...this.ledger.values()]
      .filter((entry) => !entry.sent)
      .map((entry) => entry.report);
    await this.postJson(
      '/api/worker/unregister',
      JSON.stringify({ workerId, finalReceipts } satisfies WorkerUnregister),
      this.generation,
    );
  }

  private async postJson(
    path: string,
    body: string,
    generation: number,
  ): Promise<PostResult | undefined> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.url}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.token}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return undefined;
    }
    if (this.generation !== generation) {
      this.drain(response);
      return { kind: 'stale' };
    }
    if (response.status === 401) {
      this.drain(response);
      this.fatal('forum link: hub rejected the machine token (401)');
      return { kind: 'fatal' };
    }
    return { kind: 'ok', response };
  }

  private fatal(message: string): void {
    if (!this.active) return;
    this.active = false;
    this.generation += 1;
    this.clearTimers();
    this.streamAbort?.abort();
    this.queue.length = 0;
    this.pendingReplay = [];
    this.batchInFlight = false;
    this.attempt = 0;
    this.setState('detached');
    this.options.onFatal?.(message);
  }

  private drain(response: Response): void {
    if (response.body !== null) void response.body.cancel().catch(() => {});
  }

  private backoffDelayMs(): number {
    return Math.min(
      this.timing.backoffCapMs,
      this.timing.backoffBaseMs * 2 ** Math.min(this.attempt - 1, MAX_BACKOFF_EXPONENT),
    );
  }

  private waitBackoff(delayMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.backoffResolve = resolve;
      this.backoffTimer = setTimeout(() => {
        this.backoffTimer = undefined;
        this.backoffResolve = undefined;
        resolve();
      }, delayMs);
    });
  }

  private touchSilence(generation: number): void {
    this.lastReceivedAt = this.now();
    this.armSilenceTimer(generation);
  }

  private armSilenceTimer(generation: number): void {
    if (this.silenceTimer !== undefined) clearTimeout(this.silenceTimer);
    const remaining = this.timing.heartbeatTimeoutMs - (this.now() - this.lastReceivedAt);
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = undefined;
      if (this.generation !== generation) return;
      this.streamAbort?.abort();
    }, Math.max(remaining, 0));
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer !== undefined) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = undefined;
    }
  }

  private clearTimers(): void {
    if (this.batchTimer !== undefined) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }
    if (this.backoffTimer !== undefined) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = undefined;
      this.backoffResolve?.();
      this.backoffResolve = undefined;
    }
    this.clearSilenceTimer();
  }

  private setState(next: LinkState): void {
    if (this.currentState === next) return;
    this.currentState = next;
    this.options.onStateChange?.(next);
  }
}

type ConnectOutcome =
  | { kind: 'published'; stream: ReadableStream<Uint8Array> }
  | { kind: 'retry' }
  | { kind: 'fatal' }
  | { kind: 'stale' };

type StreamOpenResult =
  | { kind: 'ok'; body: ReadableStream<Uint8Array> }
  | { kind: 'retry' }
  | { kind: 'fatal' }
  | { kind: 'stale' };

type StreamOutcome = 'stream-end' | 'stale';

type PostResult = { kind: 'ok'; response: Response } | { kind: 'stale' } | { kind: 'fatal' };
