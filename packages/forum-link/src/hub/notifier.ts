import { logLine } from '#/hub/log';

export interface NotifierOptions {
  ntfyUrl?: string;
  ntfyTopic?: string;
  ntfyToken?: string;
  publicUrl?: string;
  title?: string;
  priority?: string;
  fetchImpl?: typeof fetch;
}

export interface Notifier {
  markSeen(sessionId: string, cardId: string): void;
  notifyNewCard(sessionId: string, cardId: string): void;
}

const CARD_BODY = '有一项待处理';

export function createNotifier(options: NotifierOptions): Notifier {
  const enabled = options.ntfyUrl !== undefined && options.ntfyTopic !== undefined;
  const ntfyUrl = options.ntfyUrl?.replace(/\/+$/, '');
  const publicUrl = options.publicUrl?.replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const seen = new Set<string>();
  const keyOf = (sessionId: string, cardId: string) => JSON.stringify([sessionId, cardId]);
  return {
    markSeen(sessionId, cardId) {
      seen.add(keyOf(sessionId, cardId));
    },
    notifyNewCard(sessionId, cardId) {
      const key = keyOf(sessionId, cardId);
      if (seen.has(key)) return;
      seen.add(key);
      if (!enabled || ntfyUrl === undefined) return;
      const headers: Record<string, string> = { priority: options.priority ?? 'default' };
      if (options.title !== undefined) headers['title'] = options.title;
      if (options.ntfyToken !== undefined) headers['authorization'] = `Bearer ${options.ntfyToken}`;
      if (publicUrl !== undefined) {
        headers['click'] = `${publicUrl}/#/thread/${encodeURIComponent(sessionId)}?card=${encodeURIComponent(cardId)}`;
      }
      void fetchImpl(`${ntfyUrl}/${options.ntfyTopic}`, { method: 'POST', headers, body: CARD_BODY })
        .then((res) => {
          void res.body?.cancel().catch(() => {});
          if (!res.ok) logLine('notify-failed', `ntfy responded ${res.status} for card ${cardId}`);
        })
        .catch((error) => {
          logLine('notify-failed', `ntfy request for card ${cardId} failed: ${String(error)}`);
        });
    },
  };
}
