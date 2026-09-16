import type { AppState } from '../../types';

export type EndSessionMode = 'compaction' | 'turn' | 'immediate';

/**
 * Decides how the end-session orchestration should terminate the current
 * work: a running compaction, a running turn, or nothing to wait for. The
 * evaluation order is part of the contract — compaction wins over the
 * streaming phase, and an absent state is treated as already idle. An
 * unrecognized phase (possible only via a partially injected state or a
 * future union extension) is conservatively treated as a running turn.
 */
export function resolveEndSessionMode(appState: AppState | undefined): EndSessionMode {
  if (appState === undefined) return 'immediate';
  if (appState.isCompacting) return 'compaction';
  const phase = appState.streamingPhase;
  switch (phase) {
    case 'waiting':
    case 'thinking':
    case 'composing':
      return 'turn';
    case 'idle':
    case 'shell':
      return 'immediate';
  }
  return (phase satisfies never) ?? 'turn';
}
