import type { ILogService } from '#/_base/log/log';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { ImageRouteOutcomeEvent } from '#/app/telemetry/events';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ISessionUsageService } from '#/session/usage/sessionUsage';
import type { TokenUsage } from '#human/llm/usage';

export type ImageRouteOutcome =
  | 'gate_bypassed'
  | 'all_cached'
  | 'derive_failed'
  | 'call_failed'
  | 'partial_described'
  | 'all_described';

export interface ImageRouteRunRecord {
  readonly visionAlias?: string;
  readonly outcome: ImageRouteOutcome;
  readonly imageCount: number;
  readonly cacheHitCount: number;
  readonly describedCount: number;
  readonly deriveFailedCount: number;
  readonly durationMs: number;
  readonly usage?: TokenUsage;
  readonly turnId?: number;
  readonly descriptions: ReadonlyMap<string, string>;
}

export class RouteObserver {
  constructor(
    private readonly telemetry: ITelemetryService,
    private readonly log: ILogService,
    private readonly usage: ISessionUsageService,
    private readonly scopeContext: IAgentScopeContext,
  ) {}

  record(run: ImageRouteRunRecord): void {
    const properties: ImageRouteOutcomeEvent = {
      vision_model: run.visionAlias ?? '',
      outcome: run.outcome,
      image_count: run.imageCount,
      cache_hit_count: run.cacheHitCount,
      described_count: run.describedCount,
      derive_failed_count: run.deriveFailedCount,
      duration_ms: run.durationMs,
    };
    this.telemetry.track2('image_route_outcome', properties);
    this.log.debug('image route run finished', {
      ...properties,
      turn_id: run.turnId,
      descriptions: [...run.descriptions.entries()],
    });
    if (run.usage === undefined || run.visionAlias === undefined) return;
    void this.usage.record(this.scopeContext.agentContext, run.visionAlias, run.usage, {
      type: 'operation',
      turnId: run.turnId,
      requestKind: 'image_route',
    });
  }
}
