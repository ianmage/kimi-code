import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { Session } from '@moonshot-ai/kimi-code-sdk';

import {
  ForumLinkController,
  wrapUiHooksForForumLink,
} from '#/tui/controllers/forum-link';
import type { ReverseRPCUIHooks } from '#/tui/reverse-rpc/index';
import type { ApprovalPanelData, QuestionPanelData } from '#/tui/reverse-rpc/types';
import type { TranscriptEntry } from '#/tui/types';

const APP_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const KIMI_TUI_TS = join(APP_ROOT, 'src', 'tui', 'kimi-tui.ts');
const FORUM_LINK_DIR = join(APP_ROOT, 'src', 'tui', 'controllers', 'forum-link');
const BASE_CONTROLLER_TS = join(APP_ROOT, 'src', 'tui', 'reverse-rpc', 'base-controller.ts');

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else if (entry.endsWith('.ts')) out.push(p);
  }
  return out;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function makeEntry(overrides: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    id: 'e1',
    kind: 'assistant',
    renderMode: 'markdown',
    content: 'text',
    ...overrides,
  };
}

const fakeSession = { id: 'session-1' } as unknown as Session;

function approvalPayload(id: string): ApprovalPanelData {
  return {
    id,
    tool_call_id: `tc-${id}`,
    tool_name: 'Bash',
    action: 'run command',
    description: 'run a command',
    display: [],
    choices: [],
  };
}

function questionPayload(id: string): QuestionPanelData {
  return {
    id,
    tool_call_id: `tc-${id}`,
    questions: [
      {
        question: 'Continue?',
        multi_select: false,
        options: [{ label: 'yes' }],
      },
    ],
  };
}

function makeOriginalHooks(): ReverseRPCUIHooks {
  return {
    showApprovalPanel: vi.fn(),
    hideApprovalPanel: vi.fn(),
    showQuestionDialog: vi.fn(),
    hideQuestionDialog: vi.fn(),
  };
}

describe('ForumLinkController — 未接线零副作用', () => {
  it('constructs without throwing and starts detached', () => {
    const controller = new ForumLinkController({});
    expect(controller.state).toBe('detached');
  });

  it('observation seams are no-ops that keep state detached', () => {
    const controller = new ForumLinkController({});
    controller.onTranscriptEntry(makeEntry());
    controller.onSessionChanged(fakeSession);
    controller.onCardOpened('approval', 'up-1', approvalPayload('up-1'));
    controller.onCardClosed('approval', 'up-1');
    expect(controller.state).toBe('detached');
    expect(controller.openCards).toEqual([]);
  });

  it('stop() is idempotent', async () => {
    const controller = new ForumLinkController({});
    await controller.stop();
    await controller.stop();
    expect(controller.state).toBe('detached');
    expect(controller.openCards).toEqual([]);
  });
});

describe('ForumLinkController — 卡片状态唯一持有', () => {
  it('assigns monotonically increasing cardIds and removes closed cards', () => {
    const controller = new ForumLinkController({});

    controller.onCardOpened('approval', 'up-1', approvalPayload('up-1'));
    expect(controller.openCards).toEqual([{ cardId: 'c1', kind: 'approval', upstreamId: 'up-1' }]);

    controller.onCardOpened('question', 'up-2', questionPayload('up-2'));
    expect(controller.openCards).toEqual([
      { cardId: 'c1', kind: 'approval', upstreamId: 'up-1' },
      { cardId: 'c2', kind: 'question', upstreamId: 'up-2' },
    ]);

    controller.onCardClosed('approval', 'up-1');
    expect(controller.openCards).toEqual([{ cardId: 'c2', kind: 'question', upstreamId: 'up-2' }]);
  });

  it('cardIds are monotonic and never reused after close', () => {
    const controller = new ForumLinkController({});
    controller.onCardOpened('approval', 'up-1', approvalPayload('up-1'));
    controller.onCardClosed('approval', 'up-1');
    controller.onCardOpened('approval', 'up-1', approvalPayload('up-1'));
    expect(controller.openCards).toEqual([{ cardId: 'c2', kind: 'approval', upstreamId: 'up-1' }]);
  });

  it('closing an unknown card is a no-op', () => {
    const controller = new ForumLinkController({});
    controller.onCardOpened('approval', 'up-1', approvalPayload('up-1'));
    controller.onCardClosed('question', 'up-9');
    controller.onCardClosed('approval', 'up-9');
    expect(controller.openCards).toEqual([{ cardId: 'c1', kind: 'approval', upstreamId: 'up-1' }]);
  });
});

describe('wrapUiHooksForForumLink — S3 包装语义', () => {
  it('forwards to the original hooks first, then notifies the controller', () => {
    const original = makeOriginalHooks();
    const controller = new ForumLinkController({});
    const onCardOpened = vi.spyOn(controller, 'onCardOpened');
    const onCardClosed = vi.spyOn(controller, 'onCardClosed');
    const wrapped = wrapUiHooksForForumLink(original, controller);

    wrapped.showApprovalPanel(approvalPayload('ap-1'));
    expect(original.showApprovalPanel).toHaveBeenCalledTimes(1);
    expect(original.showApprovalPanel).toHaveBeenCalledWith(approvalPayload('ap-1'));
    expect(onCardOpened).toHaveBeenCalledTimes(1);
    expect(onCardOpened).toHaveBeenCalledWith('approval', 'ap-1', approvalPayload('ap-1'));

    wrapped.hideApprovalPanel();
    expect(original.hideApprovalPanel).toHaveBeenCalledTimes(1);
    expect(onCardClosed).toHaveBeenCalledTimes(1);
    expect(onCardClosed).toHaveBeenCalledWith('approval', 'ap-1');

    wrapped.showQuestionDialog(questionPayload('qp-1'));
    expect(original.showQuestionDialog).toHaveBeenCalledTimes(1);
    expect(onCardOpened).toHaveBeenCalledWith('question', 'qp-1', questionPayload('qp-1'));

    wrapped.hideQuestionDialog();
    expect(original.hideQuestionDialog).toHaveBeenCalledTimes(1);
    expect(onCardClosed).toHaveBeenCalledWith('question', 'qp-1');
  });

  it('a throwing original hook propagates and skips the notification', () => {
    const controller = new ForumLinkController({});
    const onCardOpened = vi.spyOn(controller, 'onCardOpened');
    const original: ReverseRPCUIHooks = {
      showApprovalPanel: () => {
        throw new Error('boom');
      },
      hideApprovalPanel: () => {},
      showQuestionDialog: () => {},
      hideQuestionDialog: () => {},
    };
    const wrapped = wrapUiHooksForForumLink(original, controller);

    expect(() => {
      wrapped.showApprovalPanel(approvalPayload('ap-1'));
    }).toThrow('boom');
    expect(onCardOpened).not.toHaveBeenCalled();
  });

  it('does not notify onCardClosed without a preceding show', () => {
    const original = makeOriginalHooks();
    const controller = new ForumLinkController({});
    const onCardClosed = vi.spyOn(controller, 'onCardClosed');
    const wrapped = wrapUiHooksForForumLink(original, controller);

    wrapped.hideApprovalPanel();
    wrapped.hideQuestionDialog();
    expect(original.hideApprovalPanel).toHaveBeenCalledTimes(1);
    expect(original.hideQuestionDialog).toHaveBeenCalledTimes(1);
    expect(onCardClosed).not.toHaveBeenCalled();
  });

  it('hide consumes the tracked id — a second hide does not re-notify', () => {
    const original = makeOriginalHooks();
    const controller = new ForumLinkController({});
    const onCardClosed = vi.spyOn(controller, 'onCardClosed');
    const wrapped = wrapUiHooksForForumLink(original, controller);

    wrapped.showApprovalPanel(approvalPayload('ap-1'));
    wrapped.hideApprovalPanel();
    wrapped.hideApprovalPanel();
    expect(onCardClosed).toHaveBeenCalledTimes(1);
    expect(onCardClosed).toHaveBeenCalledWith('approval', 'ap-1');
  });

  it('a replacement show settles the superseded card — hide closes the latest', () => {
    const original = makeOriginalHooks();
    const controller = new ForumLinkController({});
    const onCardClosed = vi.spyOn(controller, 'onCardClosed');
    const wrapped = wrapUiHooksForForumLink(original, controller);

    wrapped.showApprovalPanel(approvalPayload('ap-1'));
    wrapped.showApprovalPanel(approvalPayload('ap-2'));
    expect(onCardClosed).toHaveBeenCalledTimes(1);
    expect(onCardClosed).toHaveBeenCalledWith('approval', 'ap-1');
    wrapped.hideApprovalPanel();
    expect(onCardClosed).toHaveBeenCalledTimes(2);
    expect(onCardClosed).toHaveBeenLastCalledWith('approval', 'ap-2');
  });

  it('an undefined resolver keeps the wrapper silent — no card notifications', () => {
    const original = makeOriginalHooks();
    const controller = new ForumLinkController({});
    const onCardOpened = vi.spyOn(controller, 'onCardOpened');
    const wrapped = wrapUiHooksForForumLink(original, () => undefined);

    wrapped.showApprovalPanel(approvalPayload('ap-1'));
    expect(original.showApprovalPanel).toHaveBeenCalledTimes(1);
    expect(onCardOpened).not.toHaveBeenCalled();

    wrapped.hideApprovalPanel();
    expect(original.hideApprovalPanel).toHaveBeenCalledTimes(1);
  });

  it('a resolver picks up a controller created after the wrapper — later calls notify', () => {
    const original = makeOriginalHooks();
    const controller = new ForumLinkController({});
    const onCardOpened = vi.spyOn(controller, 'onCardOpened');
    let current: typeof controller | undefined = undefined;
    const wrapped = wrapUiHooksForForumLink(original, () => current);

    wrapped.showApprovalPanel(approvalPayload('ap-early'));
    expect(onCardOpened).not.toHaveBeenCalled();

    current = controller;
    wrapped.showApprovalPanel(approvalPayload('ap-late'));
    expect(onCardOpened).toHaveBeenCalledTimes(1);
    expect(onCardOpened).toHaveBeenCalledWith('approval', 'ap-late', approvalPayload('ap-late'));
  });
});

describe('ForumLinkController — setLinkState 单行提示（K-3）', () => {
  it('状态转移各至多一行提示，backoff 去抖', () => {
    const messages: string[] = [];
    const controller = new ForumLinkController({
      onStatus: (message) => {
        messages.push(message);
      },
    });

    controller.setLinkState('connecting');
    controller.setLinkState('published');
    controller.setLinkState('backoff');
    controller.setLinkState('backoff');
    controller.setLinkState('backoff');
    controller.setLinkState('connecting');
    controller.setLinkState('published');

    expect(messages).toEqual([
      'Forum Link: connecting...',
      'Forum Link: published',
      'Forum Link: connection lost, retrying...',
      'Forum Link: reconnecting...',
      'Forum Link: published',
    ]);
  });

  it('setLinkState 更新 controller.state', () => {
    const controller = new ForumLinkController({});
    controller.setLinkState('published');
    expect(controller.state).toBe('published');
  });

  it('→detached 提示 unpublished，初始 detached 不提示', () => {
    const messages: string[] = [];
    const controller = new ForumLinkController({
      onStatus: (message) => {
        messages.push(message);
      },
    });
    controller.setLinkState('detached');
    expect(messages).toEqual([]);
    controller.setLinkState('connecting');
    controller.setLinkState('detached');
    expect(messages).toEqual(['Forum Link: connecting...', 'Forum Link: unpublished']);
  });

  it('connecting→connecting 不重复提示', () => {
    const messages: string[] = [];
    const controller = new ForumLinkController({
      onStatus: (message) => {
        messages.push(message);
      },
    });
    controller.setLinkState('connecting');
    controller.setLinkState('connecting');
    expect(messages).toEqual(['Forum Link: connecting...']);
  });

  it('未传 onStatus 时不抛异常', () => {
    const controller = new ForumLinkController({});
    controller.setLinkState('published');
    controller.setLinkState('backoff');
    expect(controller.state).toBe('backoff');
  });
});

describe('静态审计 — kimi-tui.ts 侵入面', () => {
  it('kimi-tui.ts mentions forumLink on exactly the audited lines', () => {
    const source = readFileSync(KIMI_TUI_TS, 'utf8');
    const lines = source.split('\n');
    const hits: number[] = [];
    lines.forEach((line, index) => {
      if (/forumlink/i.test(line)) hits.push(index + 1);
    });
    const codeHits = hits.filter((n) => !lines[n - 1]?.trim().startsWith('//'));
    expect(
      codeHits.length,
      `kimi-tui.ts forumLink-related code lines (comments excluded):\n` +
        codeHits.map((n) => `  :${String(n)}  ${lines[n - 1]?.trim()}`).join('\n'),
    ).toBe(16);
  });

  it('observation seams are exactly three one-line optional-chain calls in place', () => {
    const source = readFileSync(KIMI_TUI_TS, 'utf8');
    expect(countOccurrences(source, 'this.forumLink?.')).toBe(3);

    expect(source).toContain(
      'appendTranscriptEntry(entry: TranscriptEntry): void {\n' +
        '    this.forumLink?.onTranscriptEntry(entry);',
    );
    expect(source).toContain(
      '    this.session = session;\n    this.forumLink?.onSessionChanged(session);',
    );

    expect(countOccurrences(source, 'await this.forumLink?.stop();')).toBe(1);
    const stopSeamAt = source.indexOf('await this.forumLink?.stop();');
    const stopStartAt = source.indexOf('async stop(exitCode?: number)');
    const sessionCloseAt = source.indexOf("closeSession('shutting down')");
    expect(stopStartAt).toBeGreaterThanOrEqual(0);
    expect(sessionCloseAt).toBeGreaterThan(0);
    expect(stopSeamAt).toBeGreaterThan(stopStartAt);
    expect(stopSeamAt).toBeLessThan(sessionCloseAt);
  });

  it('S3 resolves the controller lazily at the registerReverseRPCHandlers call site', () => {
    const source = readFileSync(KIMI_TUI_TS, 'utf8');
    expect(countOccurrences(source, 'wrapUiHooksForForumLink(')).toBe(1);
    const wrapAt = source.indexOf('wrapUiHooksForForumLink(');
    const registerAt = source.indexOf('registerReverseRPCHandlers(');
    expect(registerAt).toBeGreaterThanOrEqual(0);
    expect(wrapAt).toBeGreaterThan(registerAt);
    expect(countOccurrences(source, '() => this.forumLink')).toBe(1);
  });

  it('forumLink is declared private, constructed only inside ensureForumLink', () => {
    const source = readFileSync(KIMI_TUI_TS, 'utf8');
    expect(source).toMatch(/private forumLinkField\?: ForumLinkController;/);
    const constructAt = source.indexOf('createForumLinkController({');
    const ensureAt = source.indexOf('ensureForumLink(): ForumLinkController');
    expect(constructAt).toBeGreaterThan(ensureAt);
    expect(source).toContain("from './controllers/forum-link';");
  });

  it('exposes a public read-only forumLink getter delegating to the private field', () => {
    const source = readFileSync(KIMI_TUI_TS, 'utf8');
    expect(source).toContain(
      '  get forumLink(): ForumLinkController | undefined {\n' +
        '    return this.forumLinkField;\n' +
        '  }',
    );
  });

  it('reverse-rpc base-controller.ts is untouched by forum-link', () => {
    const source = readFileSync(BASE_CONTROLLER_TS, 'utf8');
    expect(source).not.toMatch(/forum/i);
  });
});

describe('静态审计 — forum-link 模块边界', () => {
  it('skeleton file set is exactly controller/credential/end-session/index/injector/link/projector', () => {
    const files = listFiles(FORUM_LINK_DIR).map((file) => basename(file)).toSorted();
    expect(files).toEqual([
      'controller.ts',
      'credential.ts',
      'end-session.ts',
      'index.ts',
      'injector.ts',
      'link.ts',
      'projector.ts',
    ]);
  });

  it('controller sources import only the allowed surface', () => {
    const files = listFiles(FORUM_LINK_DIR);
    expect(files.length).toBeGreaterThan(0);
    const forbidden =
      /from\s+['"]@moonshot-ai\/(?:agent-core-v2|kap-server|kosong|kaos|klient|node-sdk)['"]/;
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const spec = match[1] ?? '';
        if (forbidden.test(`from '${spec}'`)) offenders.push(`${file}: ${spec}`);
        if (spec.startsWith('#/') && /kap-server|agent-core/.test(spec)) {
          offenders.push(`${file}: ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('kimi-code-sdk imports are type-only', () => {
    const files = listFiles(FORUM_LINK_DIR);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const importRe = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+'@moonshot-ai\/kimi-code-sdk'/g;
      for (const match of source.matchAll(importRe)) {
        const isTypeImport = match[1] !== undefined;
        const specifiers = (match[2] ?? '')
          .split(',')
          .map((specifier) => specifier.trim())
          .filter((specifier) => specifier.length > 0);
        const allTypeSpecifiers = specifiers.every((specifier) => specifier.startsWith('type '));
        expect(
          isTypeImport || allTypeSpecifiers,
          `${file} must import from kimi-code-sdk as types only: ${match[0]}`,
        ).toBe(true);
      }
    }
  });

  it('controller sources never read forbidden TUI state (end-session.ts owns the phase decision)', () => {
    const files = listFiles(FORUM_LINK_DIR);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const forbidden of ['streamingPhase', 'pendingApproval', 'pendingQuestion']) {
        if (forbidden === 'streamingPhase' && basename(file) === 'end-session.ts') continue;
        expect(source.includes(forbidden), `${file} must not mention ${forbidden}`).toBe(false);
      }
    }
  });

  it('controller.ts wraps the real reverse-rpc hook type', () => {
    const source = readFileSync(join(FORUM_LINK_DIR, 'controller.ts'), 'utf8');
    expect(source).toContain(
      "import type { ReverseRPCUIHooks } from '../../reverse-rpc/index';",
    );
  });
});
