import type { Descriptor } from '#/contract/frames';
import { ThreadBuffer } from '#/hub/buffer';

export interface Thread {
  readonly id: string;
  readonly buffer: ThreadBuffer;
  descriptor: Descriptor;
  lastSignalAt: number;
  touch(): void;
}

export interface ThreadSummary {
  id: string;
  descriptor: Descriptor;
}

export interface RegistryOptions {
  bufferSize?: number;
  livenessWindowMs?: number;
}

export interface HubOptions {
  bufferSize?: number;
  livenessWindowMs?: number;
}

const DEFAULT_LIVENESS_WINDOW_MS = 90000;

export class Registry {
  private readonly threads = new Map<string, Thread>();
  private readonly bufferSize: number | undefined;
  private readonly livenessWindowMs: number;

  constructor(options?: RegistryOptions) {
    this.bufferSize = options?.bufferSize;
    this.livenessWindowMs = options?.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS;
  }

  create(descriptor: Descriptor): Thread {
    const thread: Thread = {
      id: crypto.randomUUID(),
      buffer: new ThreadBuffer({ bufferSize: this.bufferSize }),
      descriptor: { ...descriptor },
      lastSignalAt: Date.now(),
      touch() {
        this.lastSignalAt = Date.now();
      },
    };
    this.threads.set(thread.id, thread);
    return thread;
  }

  get(id: string): Thread | undefined {
    return this.threads.get(id);
  }

  findLiveBySessionId(sessionId: string): Thread | undefined {
    for (const thread of this.threads.values()) {
      if (thread.descriptor.sessionId === sessionId) return thread;
    }
    return undefined;
  }

  remove(id: string): void {
    this.threads.delete(id);
  }

  list(): ThreadSummary[] {
    return Array.from(this.threads.values(), (thread) => ({
      id: thread.id,
      descriptor: { ...thread.descriptor },
    }));
  }

  reap(now: number): string[] {
    const reaped: string[] = [];
    for (const thread of this.threads.values()) {
      if (now - thread.lastSignalAt > this.livenessWindowMs) {
        this.threads.delete(thread.id);
        reaped.push(thread.id);
      }
    }
    return reaped;
  }
}
