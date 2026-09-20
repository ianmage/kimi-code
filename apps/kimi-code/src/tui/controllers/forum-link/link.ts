import { parseActionFrame, type ActionFrame, type Descriptor, type UplinkFrame } from '@moonshot-ai/forum-link';

export type LinkState = 'detached' | 'connecting' | 'published' | 'backoff';

export interface LinkTiming {
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly backoffBaseMs?: number;
  readonly backoffCapMs?: number;
}

export interface LinkOptions {
  readonly timing?: LinkTiming;
  readonly onStateChange?: (state: LinkState) => void;
  readonly onAction?: (frame: ActionFrame) => void;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export interface LinkCredential {
  readonly url: string;
  readonly password: string;
}

export interface SseMessage {
  readonly event?: string;
  readonly data: string;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 90000;
const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_CAP_MS = 30000;

const DEFAULT_TIMING: Required<LinkTiming> = {
  heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
  heartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
  backoffBaseMs: DEFAULT_BACKOFF_BASE_MS,
  backoffCapMs: DEFAULT_BACKOFF_CAP_MS,
};

const REQUEST_TIMEOUT_MS = 10000;

function normalizeTiming(timing: LinkTiming | undefined): Required<LinkTiming> {
  if (timing === undefined) return { ...DEFAULT_TIMING };
  return {
    heartbeatIntervalMs: timing.heartbeatIntervalMs ?? DEFAULT_TIMING.heartbeatIntervalMs,
    heartbeatTimeoutMs: timing.heartbeatTimeoutMs ?? DEFAULT_TIMING.heartbeatTimeoutMs,
    backoffBaseMs: timing.backoffBaseMs ?? DEFAULT_TIMING.backoffBaseMs,
    backoffCapMs: timing.backoffCapMs ?? DEFAULT_TIMING.backoffCapMs,
  };
}

/**
 * Incremental server-sent-events parser: frames are separated by a blank
 * line, consecutive `data:` lines join with `\n` (SSE spec), the `event:`
 * field is captured, and `:` comment lines are dropped — the optional
 * `onComment` callback still fires for them so callers can treat heartbeat
 * comments as liveness. CRLF endings and multibyte characters split across
 * chunks are safe: one stateful TextDecoder decodes, `\r\n` is normalized to
 * `\n`, and only complete frames are consumed.
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  onComment?: () => void,
): AsyncGenerator<SseMessage, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
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
    buffer = buffer.replaceAll('\r\n', '\n');
    const message = parseSseBlock(buffer, onComment);
    if (message !== undefined) yield message;
  } finally {
    reader.releaseLock();
  }
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

type CycleOutcome =
  | { kind: 'published'; threadId: string; body: ReadableStream<Uint8Array> }
  | { kind: 'retry' }
  | { kind: 'fatal'; error: Error }
  | { kind: 'superseded' };

type StreamOpenResult =
  | { kind: 'ok'; body: ReadableStream<Uint8Array> }
  | { kind: 'retry' }
  | { kind: 'fatal'; error: Error }
  | { kind: 'superseded' };

type StreamOutcome = 'lost' | 'superseded';

export class Link {
  private currentState: LinkState = 'detached';
  private credential: LinkCredential | undefined;
  private registerSource: (() => Descriptor) | undefined;
  private currentThreadId: string | undefined;
  private attempt = 0;
  private generation = 0;
  private settleConnect: ((error: Error | undefined) => void) | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private backoffTimer: ReturnType<typeof setTimeout> | undefined;
  private backoffResolve: (() => void) | undefined;
  private streamAbort: AbortController | undefined;
  private lastReceivedAt = 0;
  private readonly timing: Required<LinkTiming>;
  private readonly onStateChange?: (state: LinkState) => void;
  private readonly onAction?: (frame: ActionFrame) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: LinkOptions = {}) {
    this.timing = normalizeTiming(options.timing);
    this.onStateChange = options.onStateChange;
    this.onAction = options.onAction;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  get state(): LinkState {
    return this.currentState;
  }

  get threadId(): string | undefined {
    return this.currentThreadId;
  }

  /**
   * Connects to the hub and keeps the connection alive in the background.
   * The returned promise settles when the link first reaches `published`
   * (resolve) or dies on a fatal error — 401, a malformed hub response, or
   * `close()` racing a still-pending connect (reject). While the link is
   * retrying in backoff the promise stays pending; a later success still
   * resolves it, so a caller awaiting "published" is served by both the
   * direct connect and the reconnect path.
   */
  async connect(credential: LinkCredential, registerSource: () => Descriptor): Promise<void> {
    if (this.currentState !== 'detached') throw new Error('link is not detached');
    this.credential = credential;
    this.registerSource = registerSource;
    this.generation += 1;
    const generation = this.generation;
    return new Promise<void>((resolve, reject) => {
      this.settleConnect = (error) => {
        this.settleConnect = undefined;
        if (error === undefined) resolve();
        else reject(error);
      };
      void this.connectionLoop(generation);
    });
  }

  /** Best-effort uplink; frames sent while not published are dropped. */
  send(frame: UplinkFrame): void {
    const threadId = this.currentThreadId;
    const credential = this.credential;
    if (this.currentState !== 'published' || threadId === undefined || credential === undefined) return;
    void this.postJson(credential, `/api/entry?target=${encodeURIComponent(threadId)}`, JSON.stringify(frame))
      .then((response) => {
        this.drain(response);
        if (response.status === 401) this.fatal(new Error('unauthorized'));
      })
      .catch(() => {});
  }

  /** Idempotent teardown: detach the stream, stop timers, forget the thread. */
  close(reason?: string): void {
    if (this.currentState === 'detached') {
      this.settleConnect?.(new Error(reason ?? 'closed'));
      return;
    }
    this.detach(new Error(reason ?? 'closed'));
  }

  private async connectionLoop(generation: number): Promise<void> {
    for (;;) {
      if (this.generation !== generation) return;
      this.setState('connecting');
      const credential = this.credential;
      const registerSource = this.registerSource;
      if (credential === undefined || registerSource === undefined) return;
      const cycle = await this.runCycle(credential, registerSource(), generation);
      if (this.generation !== generation) return;
      if (cycle.kind === 'superseded') return;
      if (cycle.kind === 'fatal') {
        this.detach(cycle.error);
        return;
      }
      if (cycle.kind === 'retry') {
        this.attempt += 1;
        this.setState('backoff');
        await this.waitBackoff(this.backoffDelayMs());
        continue;
      }
      this.attempt = 0;
      this.currentThreadId = cycle.threadId;
      this.setState('published');
      this.settleConnect?.(undefined);
      this.startHeartbeat(credential, cycle.threadId);
      const outcome = await this.consumeStream(cycle.body, generation);
      this.stopStream();
      if (this.generation !== generation) return;
      if (outcome === 'superseded') return;
      this.attempt += 1;
      this.setState('backoff');
      await this.waitBackoff(this.backoffDelayMs());
    }
  }

  private async runCycle(
    credential: LinkCredential,
    register: Descriptor,
    generation: number,
  ): Promise<CycleOutcome> {
    let response: Response;
    try {
      response = await this.postJson(credential, '/api/register', JSON.stringify(register));
    } catch {
      return { kind: 'retry' };
    }
    if (this.generation !== generation) {
      this.drain(response);
      return { kind: 'superseded' };
    }
    if (response.status === 401) {
      this.drain(response);
      return { kind: 'fatal', error: new Error('unauthorized') };
    }
    if (response.status === 429 || response.status >= 500) {
      this.drain(response);
      return { kind: 'retry' };
    }
    if (!response.ok) {
      this.drain(response);
      return { kind: 'fatal', error: new Error(`register failed with status ${response.status}`) };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: 'fatal', error: new Error('register returned invalid json') };
    }
    const id = typeof body === 'object' && body !== null && 'id' in body ? (body as { id: unknown }).id : undefined;
    if (typeof id !== 'string' || id === '') {
      return { kind: 'fatal', error: new Error('register returned no thread id') };
    }
    const stream = await this.openStream(credential, id, generation);
    if (stream.kind === 'ok') return { kind: 'published', threadId: id, body: stream.body };
    return stream;
  }

  private async openStream(
    credential: LinkCredential,
    threadId: string,
    generation: number,
  ): Promise<StreamOpenResult> {
    this.streamAbort = new AbortController();
    this.lastReceivedAt = this.now();
    this.armSilenceTimer(generation);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${credential.url}/api/stream/${encodeURIComponent(threadId)}?key=${encodeURIComponent(credential.password)}`,
        { headers: { accept: 'text/event-stream' }, signal: this.streamAbort.signal },
      );
    } catch {
      this.clearSilenceTimer();
      return { kind: 'retry' };
    }
    if (this.generation !== generation) {
      this.clearSilenceTimer();
      this.drain(response);
      return { kind: 'superseded' };
    }
    if (response.status === 401) {
      this.clearSilenceTimer();
      this.drain(response);
      return { kind: 'fatal', error: new Error('unauthorized') };
    }
    if (!response.ok || response.body === null) {
      this.clearSilenceTimer();
      this.drain(response);
      return { kind: 'retry' };
    }
    return { kind: 'ok', body: response.body };
  }

  private async consumeStream(body: ReadableStream<Uint8Array>, generation: number): Promise<StreamOutcome> {
    const markAlive = () => {
      this.lastReceivedAt = this.now();
      this.armSilenceTimer(generation);
    };
    try {
      for await (const message of parseSseStream(body, markAlive)) {
        markAlive();
        this.dispatchSseData(message.data);
      }
    } catch {
      return this.streamOutcome(generation);
    }
    return this.streamOutcome(generation);
  }

  private dispatchSseData(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || !('action' in parsed)) return;
    const result = parseActionFrame((parsed as { action: unknown }).action);
    if (result.ok) this.onAction?.(result.frame);
  }

  private startHeartbeat(credential: LinkCredential, threadId: string): void {
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat(credential, threadId);
    }, this.timing.heartbeatIntervalMs);
    void this.sendHeartbeat(credential, threadId);
  }

  private async sendHeartbeat(credential: LinkCredential, threadId: string): Promise<void> {
    try {
      const response = await this.postJson(credential, '/api/heartbeat', JSON.stringify({ target: threadId }));
      this.drain(response);
      if (response.status === 401) this.fatal(new Error('unauthorized'));
    } catch {
      // heartbeat delivery failures are not fatal; sse silence decides liveness
    }
  }

  private postJson(credential: LinkCredential, path: string, body: string): Promise<Response> {
    return this.fetchImpl(`${credential.url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.password}`, 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  private drain(response: Response): void {
    if (response.body !== null) void response.body.cancel().catch(() => {});
  }

  private backoffDelayMs(): number {
    return Math.min(this.timing.backoffCapMs, this.timing.backoffBaseMs * 2 ** Math.min(this.attempt - 1, 5));
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

  private streamOutcome(generation: number): StreamOutcome {
    return this.generation === generation ? 'lost' : 'superseded';
  }

  private stopStream(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.silenceTimer !== undefined) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = undefined;
    }
    this.streamAbort?.abort();
    this.streamAbort = undefined;
  }

  private detach(error: Error): void {
    this.generation += 1;
    this.stopStream();
    if (this.backoffTimer !== undefined) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = undefined;
    }
    this.backoffResolve?.();
    this.backoffResolve = undefined;
    this.credential = undefined;
    this.registerSource = undefined;
    this.currentThreadId = undefined;
    this.attempt = 0;
    this.setState('detached');
    this.settleConnect?.(error);
  }

  private fatal(error: Error): void {
    if (this.currentState === 'detached') return;
    this.detach(error);
  }

  private setState(next: LinkState): void {
    if (this.currentState === next) return;
    this.currentState = next;
    this.onStateChange?.(next);
  }
}
