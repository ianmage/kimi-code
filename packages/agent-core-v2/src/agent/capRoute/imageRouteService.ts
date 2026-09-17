import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { isAbortError } from '#/_base/utils/abort';
import { ILogService } from '#/_base/log/log';
import { LifecycleScope } from '#/app/scopes';
import { IConfigService } from '#/app/config/config';
import { IFileService } from '#/app/file/fileService';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { isUnauthorizedLlmError, llmMessageFromError } from '#/llm-adapter/contract/errors';
import type { ContentPart, Message } from '#/llm-adapter/contract/message';
import { IModelCatalog } from '#/llm-adapter/model/catalog';
import type { ModelRequester } from '#/llm-adapter/model/model-requester';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import type { AgentLLMRequestSource } from '#/agent/llmRequester/llmRequester';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { TokenUsage } from '#human/llm/usage';

import { CAP_ROUTE_SECTION, type CapRouteConfig } from './configSection';
import { DescriptionCache, type VisionIdentity } from './descriptionCache';
import { collectImages, dedupeByIdentity, deriveVisionParts } from './imageCollector';
import { IAgentImageRouteService } from './imageRoute';
import { injectDescriptions, type RoutableImage } from './injector';
import { RouteObserver, type ImageRouteRunRecord } from './routeObserver';
import { parseSlots } from './slotParser';
import { VisionCallError, buildIntentAnchor, describeImages } from './visionCall';

type GateWarnReason = 'unresolved' | 'no_image_in';

interface VisionTarget {
  readonly alias: string;
  readonly providerType: string;
  readonly modelName: string;
  readonly requester: ModelRequester;
}

function outcomeOf(input: {
  readonly cacheHitCount: number;
  readonly missCount: number;
  readonly callCount: number;
  readonly callFailed: boolean;
  readonly describedCount: number;
}): ImageRouteRunRecord['outcome'] {
  if (input.missCount === 0) return 'all_cached';
  if (input.callCount === 0) return 'derive_failed';
  if (input.callFailed) return 'call_failed';
  return input.describedCount === input.callCount ? 'all_described' : 'partial_described';
}

function isPenetratingError(error: unknown): boolean {
  return (
    isAbortError(error) ||
    isUnauthorizedLlmError(error) ||
    isUnauthorizedLlmError(llmMessageFromError(error))
  );
}

export class AgentImageRouteService implements IAgentImageRouteService {
  declare readonly _serviceBrand: undefined;

  private readonly cache: DescriptionCache;
  private readonly observer: RouteObserver;
  private readonly gateWarnings = new Set<string>();

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @ILogService private readonly log: ILogService,
    @IBlobStore private readonly blobs: IBlobStore,
    @ISessionMediaStore private readonly mediaStore: ISessionMediaStore,
    @IFileService private readonly files: IFileService,
    @ITelemetryService telemetry: ITelemetryService,
    @ISessionUsageService usage: ISessionUsageService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
  ) {
    this.cache = new DescriptionCache(blobs);
    this.observer = new RouteObserver(telemetry, log, usage, scopeContext);
  }

  async route(
    messages: readonly Message[],
    requester: ModelRequester,
    source: AgentLLMRequestSource | undefined,
    signal: AbortSignal | undefined,
  ): Promise<readonly Message[]> {
    const startedAt = Date.now();
    const alias = this.config.get<CapRouteConfig>(CAP_ROUTE_SECTION)?.imageRoute;
    if (!alias) return messages;
    const bypass = (outcome: ImageRouteRunRecord['outcome']): readonly Message[] => {
      this.observer.record({
        visionAlias: alias,
        outcome,
        imageCount: 0,
        cacheHitCount: 0,
        describedCount: 0,
        deriveFailedCount: 0,
        durationMs: Date.now() - startedAt,
        turnId: source?.type === 'turn' ? source.turnId : undefined,
        descriptions: new Map(),
      });
      return messages;
    };
    if (requester.model.capabilities.image_in) return bypass('gate_bypassed');
    if (source?.type !== 'turn') return bypass('gate_bypassed');
    const target = this.resolveTarget(alias);
    if (target === undefined) return bypass('gate_bypassed');

    const collected = await this.collectSafely(messages);
    if (collected.length === 0) return bypass('gate_bypassed');

    const vision: VisionIdentity = {
      providerType: target.providerType,
      modelName: target.modelName,
    };
    const descriptions = new Map<string, string>();
    const misses: RoutableImage[] = [];
    for (const image of dedupeByIdentity(collected)) {
      const hit = await this.cache.get(image.identity, vision);
      if (hit !== undefined) descriptions.set(image.identity, hit);
      else misses.push(image);
    }
    const cacheHitCount = descriptions.size;

    let callSet: readonly (RoutableImage & { visionPart: ContentPart })[] = [];
    if (misses.length > 0) {
      callSet = await deriveVisionParts(
        misses,
        { files: this.files, mediaStore: this.mediaStore },
        signal,
      );
    }

    let describedCount = 0;
    let callFailed = false;
    let usage: TokenUsage | undefined;
    if (callSet.length > 0) {
      const settled = await this.callAndSettle(target.requester, callSet, messages, signal);
      if (settled.usage !== undefined) usage = settled.usage;
      callFailed = settled.callFailed;
      for (const [identity, description] of settled.descriptions) {
        descriptions.set(identity, description);
        describedCount += 1;
        await this.cache.put(identity, vision, description);
      }
    }

    const out = injectDescriptions(messages, collected, descriptions);
    this.observer.record({
      visionAlias: alias,
      outcome: outcomeOf({
        cacheHitCount,
        missCount: misses.length,
        callCount: callSet.length,
        callFailed,
        describedCount,
      }),
      imageCount: cacheHitCount + callSet.length,
      cacheHitCount,
      describedCount,
      deriveFailedCount: misses.length - callSet.length,
      durationMs: Date.now() - startedAt,
      usage,
      turnId: source.turnId,
      descriptions,
    });
    return out;
  }

  private resolveTarget(alias: string): VisionTarget | undefined {
    let requester: ModelRequester;
    try {
      requester = this.modelCatalog.getRequester(alias);
    } catch {
      this.warnOnce(alias, 'unresolved');
      return undefined;
    }
    if (!requester.model.capabilities.image_in) {
      this.warnOnce(alias, 'no_image_in');
      return undefined;
    }
    const model = requester.model;
    return {
      alias,
      providerType: model.providerType ?? model.protocol ?? '',
      modelName: model.name,
      requester,
    };
  }

  private warnOnce(alias: string, reason: GateWarnReason): void {
    const key = `${alias}\0${reason}`;
    if (this.gateWarnings.has(key)) return;
    this.gateWarnings.add(key);
    this.log.warn('image route bypassed: configured vision alias is not usable', {
      alias,
      reason,
    });
  }

  private async collectSafely(messages: readonly Message[]): Promise<readonly RoutableImage[]> {
    try {
      return await collectImages(messages, this.mediaStore);
    } catch (error) {
      if (isPenetratingError(error)) throw error;
      return [];
    }
  }

  private async callAndSettle(
    requester: ModelRequester,
    callSet: readonly (RoutableImage & { visionPart: ContentPart })[],
    messages: readonly Message[],
    signal: AbortSignal | undefined,
  ): Promise<{
    descriptions: ReadonlyMap<string, string>;
    usage: TokenUsage | undefined;
    callFailed: boolean;
  }> {
    const settled = new Map<string, string>();
    let text: string;
    let usage: TokenUsage | undefined;
    try {
      const result = await describeImages(requester, callSet, buildIntentAnchor(messages), signal);
      text = result.text;
      usage = result.usage;
    } catch (error) {
      if (!(error instanceof VisionCallError)) throw error;
      return { descriptions: settled, usage: undefined, callFailed: true };
    }
    const slots = parseSlots(text, callSet.length);
    for (const [index, image] of callSet.entries()) {
      const description = slots[index];
      if (description !== undefined) settled.set(image.identity, description);
    }
    return { descriptions: settled, usage, callFailed: false };
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentImageRouteService,
  AgentImageRouteService,
  ScopeActivation.OnScopeCreated,
  'capRoute',
);
