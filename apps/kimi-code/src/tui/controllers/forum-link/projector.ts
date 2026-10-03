import type { Event, GoalSnapshot, ModelAlias, SessionPlan } from '@moonshot-ai/kimi-code-sdk';
import { LIMITS, type BackgroundTaskFold, type Card, type DiffExtraLine, type GoalSnapshotPayload, type Overview, type PlanBodyExtra, type SubagentFold, type TimelineEntry } from '@moonshot-ai/forum-link';

import { MAIN_AGENT_ID } from '#/tui/constant/kimi-tui';
import { modelDisplayName, segmentsFor } from '#/tui/components/dialogs/model-selector';
import { pickChip } from '#/tui/components/messages/tool-renderers/chip';
import { extractKeyArgument } from '#/tui/components/messages/tool-call';
import { computeDiffLines } from '#/tui/components/media/diff-preview';
import type { TodoItem } from '#/tui/components/chrome/todo-panel';
import type {
  ApprovalPanelData,
  DiffDisplayBlock,
  QuestionPanelData,
} from '#/tui/reverse-rpc/types';
import type { AppState, TranscriptEntry } from '../../types';

export type ProjectorStatus = 'waiting-question' | 'running' | 'idle';
export type EventFold = SubagentFold | BackgroundTaskFold;

export interface ProjectorLimits {
  readonly timelineRingLength?: number;
  readonly maxTextChars?: number;
  readonly maxFoldLength?: number;
  readonly maxCardFieldChars?: number;
  readonly maxDiffLines?: number;
}

export interface ProjectorOptions {
  readonly limits?: ProjectorLimits;
  readonly mainAgentId?: string;
  readonly now?: () => number;
  readonly getPlan?: () => Promise<SessionPlan>;
}

export type SampleAppState = Pick<
  AppState,
  | 'streamingPhase'
  | 'isCompacting'
  | 'model'
  | 'thinkingEffort'
  | 'permissionMode'
  | 'planMode'
  | 'contextUsage'
  | 'goal'
>;

const ANSI_PATTERN = /\u001B\[[0-9;?]*[A-Za-z]/g;

const SUBAGENT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'subagent.spawned',
  'subagent.started',
  'subagent.completed',
  'subagent.failed',
  'subagent.suspended',
]);

const BACKGROUND_TASK_EVENT_TYPES: ReadonlySet<string> = new Set([
  'background.task.started',
  'background.task.terminated',
]);

const DEFAULT_LIMITS: {
  timelineRingLength: number;
  maxTextChars: number;
  maxFoldLength: number;
  maxCardFieldChars: number;
  maxDiffLines: number;
} = {
  timelineRingLength: 200,
  maxTextChars: 4000,
  maxFoldLength: 20,
  maxCardFieldChars: LIMITS.maxTextFieldLength,
  maxDiffLines: 500,
};

const TOOL_CALL_MEMORY = 64;

export function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

function isTruncatableString(value: unknown): value is string {
  return typeof value === 'string';
}

const CARD_TRUNCATABLE_KEYS: ReadonlySet<string> = new Set([
  'text',
  'command',
  'content',
  'old_text',
  'new_text',
  'description',
  'detail',
  'danger',
  'query',
  'label',
  'body',
  'question',
  'path',
  'url',
  'cwd',
  'objective',
  'completionCriterion',
  'summary',
  'prompt',
  'scope',
]);

function truncateCardField(value: unknown, maxChars: number): { value: unknown; truncated: boolean } {
  if (!isTruncatableString(value)) return { value, truncated: false };
  if (value.length <= maxChars) return { value, truncated: false };
  return { value: value.slice(0, maxChars), truncated: true };
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

function truncateCardPayload(payload: unknown, maxChars: number): { payload: unknown; truncated: boolean } {
  let truncated = false;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node !== 'object' || node === null) return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (CARD_TRUNCATABLE_KEYS.has(key)) {
        const result = truncateCardField(value, maxChars);
        if (result.truncated) truncated = true;
        out[key] = result.value;
      } else {
        out[key] = walk(value);
      }
    }
    return out;
  };
  return { payload: walk(payload), truncated };
}

export function deriveDiffLines(block: DiffDisplayBlock, maxLines: number): DiffExtraLine[] {
  return computeDiffLines(
    block.old_text,
    block.new_text,
    block.old_start,
    block.new_start,
  )
    .map((line): DiffExtraLine => {
      if (line.kind === 'add') return { op: 'add', newNo: line.lineNum, text: line.code };
      if (line.kind === 'delete') return { op: 'del', oldNo: line.lineNum, text: line.code };
      return { op: 'ctx', newNo: line.lineNum, text: line.code };
    })
    .slice(0, maxLines);
}

function isPlanReviewApproval(payload: ApprovalPanelData): boolean {
  return payload.tool_name === 'ExitPlanMode';
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

function projectGoal(goal: GoalSnapshot): GoalSnapshotPayload {
  return {
    goalId: goal.goalId,
    objective: goal.objective,
    completionCriterion: goal.completionCriterion,
    status: goal.status,
    turnsUsed: goal.turnsUsed,
    tokensUsed: goal.tokensUsed,
    wallClockMs: goal.wallClockMs,
    budget: goal.budget,
    terminalReason: goal.terminalReason,
  };
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line === undefined) continue;
    if (line.length > 0) return line;
  }
  return '';
}

interface KnownToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export class Projector {
  private readonly limits: typeof DEFAULT_LIMITS;
  private readonly mainAgentId: string;
  private readonly now: () => number;
  private readonly getPlan: (() => Promise<SessionPlan>) | undefined;

  private ring: TimelineEntry[] = [];
  private nextSeq = 1;
  private lastStatusPhase: string | undefined;
  private turnText = '';
  private turnActive = false;
  private lastAssistantLine = '';
  private subagentFolds: SubagentFold[] = [];
  private backgroundTaskFolds: BackgroundTaskFold[] = [];
  private toolCalls = new Map<string, KnownToolCall>();
  private overviewRev = 0;

  constructor(options: ProjectorOptions = {}) {
    this.limits = {
      timelineRingLength: options.limits?.timelineRingLength ?? DEFAULT_LIMITS.timelineRingLength,
      maxTextChars: options.limits?.maxTextChars ?? DEFAULT_LIMITS.maxTextChars,
      maxFoldLength: options.limits?.maxFoldLength ?? DEFAULT_LIMITS.maxFoldLength,
      maxCardFieldChars: options.limits?.maxCardFieldChars ?? DEFAULT_LIMITS.maxCardFieldChars,
      maxDiffLines: options.limits?.maxDiffLines ?? DEFAULT_LIMITS.maxDiffLines,
    };
    this.mainAgentId = options.mainAgentId ?? MAIN_AGENT_ID;
    this.now = options.now ?? Date.now;
    this.getPlan = options.getPlan;
  }

  get ringCapacity(): number {
    return this.limits.timelineRingLength;
  }

  snapshotTimeline(): TimelineEntry[] {
    return this.ring.map((entry) => ({ ...entry }));
  }

  get eventFolds(): readonly EventFold[] {
    return [...this.subagentFolds, ...this.backgroundTaskFolds];
  }

  handleEvent(event: Event): TimelineEntry | undefined {
    this.foldTrackedEvent(event);
    if (event.agentId !== this.mainAgentId) return undefined;
    // oxlint-disable-next-line typescript-eslint/switch-exhaustiveness-check -- Whitelist projection: unmatched event types are intentionally dropped.
    switch (event.type) {
      case 'turn.started':
        this.turnText = '';
        this.turnActive = true;
        return undefined;
      case 'assistant.delta':
        this.turnText += event.delta;
        this.turnActive = true;
        return undefined;
      case 'turn.ended':
        return this.flushTurn();
      case 'tool.call.started':
        this.recordToolCall(event.toolCallId, event.name, event.args);
        return this.pushEntry({
          kind: 'tool-call',
          toolCallId: event.toolCallId,
          name: event.name,
          keyArg: this.keyArgFor(event.name, event.args),
        });
      case 'tool.result':
        return this.pushEntry(this.buildToolResultEntry(event));
      default:
        return undefined;
    }
  }

  onTranscriptEntry(entry: TranscriptEntry): TimelineEntry | undefined {
    if (entry.kind !== 'user') return undefined;
    const text = stripAnsiCodes(entry.content).trim();
    if (text.length === 0) return undefined;
    const { text: bounded } = truncateText(text, this.limits.maxTextChars);
    return this.pushEntry({ kind: 'user-message', text: bounded });
  }

  onCardOpened(
    kind: 'approval' | 'question',
    cardId: string,
    _payload: ApprovalPanelData | QuestionPanelData,
  ): TimelineEntry {
    return this.pushEntry({ kind: 'card-opened', card: { cardId, kind } });
  }

  onCardSettled(cardId: string, outcome: string): TimelineEntry {
    return this.pushEntry({ kind: 'card-settled', cardId, outcome });
  }

  onStatusPhase(phase: string): TimelineEntry | undefined {
    if (phase === this.lastStatusPhase) return undefined;
    this.lastStatusPhase = phase;
    return this.pushEntry({ kind: 'status', phase });
  }

  sampleOverview(
    appState: SampleAppState,
    todos: readonly TodoItem[],
    eventFolds: readonly EventFold[],
    availableModels: Record<string, ModelAlias>,
    lastLine: string,
  ): Overview {
    this.overviewRev += 1;
    const subagents = eventFolds
      .filter((fold): fold is SubagentFold => fold.category === 'subagent')
      .slice(-this.limits.maxFoldLength);
    const backgroundTasks = eventFolds
      .filter((fold): fold is BackgroundTaskFold => fold.category === 'background-task')
      .slice(-this.limits.maxFoldLength);
    const models = Object.entries(availableModels).map(([alias, model]) => ({
      alias,
      displayName: modelDisplayName(alias, model),
      efforts: [...segmentsFor(model)],
    }));
    const { text: boundedLastLine } = truncateText(
      this.resolveLastLine(lastLine),
      this.limits.maxTextChars,
    );
    return {
      rev: this.overviewRev,
      phase: appState.streamingPhase,
      isCompacting: appState.isCompacting,
      model: appState.model,
      thinkingEffort: appState.thinkingEffort,
      permissionMode: appState.permissionMode,
      planMode: appState.planMode,
      contextUsage: appState.contextUsage,
      goal: appState.goal === null || appState.goal === undefined
        ? null
        : projectGoal(appState.goal),
      todos: todos.map((todo) => ({ title: todo.title, status: todo.status })),
      subagents,
      backgroundTasks,
      models,
      lastLine: boundedLastLine,
      sampledAt: this.now(),
    };
  }

  projectCard(cardId: string, payload: ApprovalPanelData | QuestionPanelData): Card {
    const isQuestion = 'questions' in payload;
    const kind: Card['kind'] = isQuestion ? 'question' : 'approval';
    const { payload: bounded, truncated } = truncateCardPayload(
      deepClone(payload),
      this.limits.maxCardFieldChars,
    );
    if (isQuestion) {
      const card: Card = {
        cardId,
        kind,
        openedAt: this.now(),
        question: bounded as Card['question'],
      };
      if (truncated) card['truncated'] = true;
      return card;
    }
    const approval = bounded as ApprovalPanelData;
    const display = Array.isArray(approval.display) ? approval.display : [];
    const projectedDisplay = display.map((block) => {
      if (block !== null && typeof block === 'object' && block.type === 'diff') {
        return { ...block, lines: deriveDiffLines(block, this.limits.maxDiffLines) };
      }
      return block;
    });
    if (isPlanReviewApproval(payload) && this.getPlan !== undefined) {
      void this.getPlan()
        .then((plan) => {
          if (plan === null) return;
          this.pendingPlanBodies.set(cardId, plan.content);
        })
        .catch(() => {});
    }
    const card: Card = {
      cardId,
      kind,
      openedAt: this.now(),
      approval: { ...approval, display: projectedDisplay },
    };
    if (truncated) card['truncated'] = true;
    return card;
  }

  takePlanBody(cardId: string): string | undefined {
    return this.pendingPlanBodies.get(cardId);
  }

  planBodyBlock(cardId: string): PlanBodyExtra | undefined {
    const text = this.pendingPlanBodies.get(cardId);
    return text === undefined ? undefined : { type: 'plan_body', text };
  }

  private readonly pendingPlanBodies = new Map<string, string>();

  private foldTrackedEvent(event: Event): void {
    const type = event.type as string;
    if (SUBAGENT_EVENT_TYPES.has(type)) {
      this.subagentFolds.push({ ...event, category: 'subagent', at: this.now() });
      if (this.subagentFolds.length > this.limits.maxFoldLength) this.subagentFolds.shift();
      return;
    }
    if (BACKGROUND_TASK_EVENT_TYPES.has(type)) {
      this.backgroundTaskFolds.push({ ...event, category: 'background-task', at: this.now() });
      if (this.backgroundTaskFolds.length > this.limits.maxFoldLength) this.backgroundTaskFolds.shift();
    }
  }

  private recordToolCall(toolCallId: string, name: string, args: unknown): void {
    if (this.toolCalls.size >= TOOL_CALL_MEMORY) {
      const oldest = this.toolCalls.keys().next().value;
      if (oldest !== undefined) this.toolCalls.delete(oldest);
    }
    const record = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
    this.toolCalls.set(toolCallId, { name, args: record });
  }

  private keyArgFor(name: string, args: unknown): string {
    if (typeof args !== 'object' || args === null) return '';
    return extractKeyArgument(name, args as Record<string, unknown>) ?? '';
  }

  private buildToolResultEntry(
    event: Extract<Event, { type: 'tool.result' }>,
  ): Omit<Extract<TimelineEntry, { kind: 'tool-result' }>, 'seq' | 'at'> {
    const known = this.toolCalls.get(event.toolCallId);
    const chip =
      known !== undefined && typeof event.output === 'string'
        ? chipForToolResult(known.name, known.args, event.output)
        : undefined;
    return {
      kind: 'tool-result',
      toolCallId: event.toolCallId,
      ok: event.isError !== true,
      chip,
    };
  }

  private flushTurn(): TimelineEntry | undefined {
    if (this.turnText.length > 0) {
      const { text, truncated } = truncateText(this.turnText, this.limits.maxTextChars);
      if (text.length > 0) {
        const entry = this.pushEntry({ kind: 'assistant-turn', text, truncated });
        const line = lastNonEmptyLine(this.turnText);
        if (line.length > 0) this.lastAssistantLine = line;
        this.turnText = '';
        this.turnActive = false;
        return entry;
      }
    }
    this.turnText = '';
    this.turnActive = false;
    return undefined;
  }

  private resolveLastLine(incoming: string): string {
    if (this.turnActive) {
      const line = lastNonEmptyLine(this.turnText);
      if (line.length > 0) return line;
    }
    if (incoming.length > 0) return incoming;
    return this.lastAssistantLine;
  }

  private pushEntry(entry: TimelineEntryInput): TimelineEntry {
    const full: TimelineEntry = { ...entry, seq: this.nextSeq, at: this.now() };
    this.nextSeq += 1;
    this.ring.push(full);
    if (this.ring.length > this.limits.timelineRingLength) {
      this.ring.splice(0, this.ring.length - this.limits.timelineRingLength);
    }
    return full;
  }
}

type TimelineEntryInput =
  | Omit<Extract<TimelineEntry, { kind: 'user-message' }>, 'seq' | 'at'>
  | Omit<Extract<TimelineEntry, { kind: 'assistant-turn' }>, 'seq' | 'at'>
  | Omit<Extract<TimelineEntry, { kind: 'tool-call' }>, 'seq' | 'at'>
  | Omit<Extract<TimelineEntry, { kind: 'tool-result' }>, 'seq' | 'at'>
  | Omit<Extract<TimelineEntry, { kind: 'card-opened' }>, 'seq' | 'at'>
  | Omit<Extract<TimelineEntry, { kind: 'card-settled' }>, 'seq' | 'at'>
  | Omit<Extract<TimelineEntry, { kind: 'status' }>, 'seq' | 'at'>;

function chipForToolResult(
  name: string,
  args: Record<string, unknown>,
  output: string,
): string | undefined {
  const provider = pickChip(name);
  if (provider === undefined) return undefined;
  const chip = provider(
    { id: '', name, args },
    { tool_call_id: '', output, is_error: false },
  );
  return chip.length > 0 ? chip : undefined;
}
