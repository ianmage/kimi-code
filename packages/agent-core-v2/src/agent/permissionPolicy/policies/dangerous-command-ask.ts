import {
  IBashParserService,
  type BashParseResult,
  type BashSyntaxNode,
} from '#/app/bashParser/bashParser';
import { IConfigService } from '#/app/config/config';
import { ILogService } from '#/_base/log/log';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { isDangerousCommandGuardEnabled } from '#/agent/permissionRules/configSection';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import type { RuntimeLease } from '#/runtime/runtime';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import type {
  PermissionMode,
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { isRmEligible, type CommandVerdict } from './rm-eligibility';

const PARSE_OPTIONS = { timeoutMs: 500, maxNodes: 10_000 } as const;

const MAX_NESTED_SHELL_DEPTH = 4;

const UNSAFE_OPERAND = /[$`*?[\]~]/;

const SKIPPED_COMMAND_CHILDREN: ReadonlySet<string> = new Set([
  'variable_assignment',
  'file_redirect',
  'heredoc_redirect',
]);

const SIMPLE_DANGEROUS_COMMANDS: ReadonlySet<string> = new Set([
  'shutdown',
  'halt',
  'poweroff',
  'reboot',
  'bcdedit',
  'diskpart',
  'format',
  'restart-computer',
  'stop-computer',
  'mkfs',
  'wipefs',
]);

const PRIVILEGE_WRAPPERS: ReadonlySet<string> = new Set(['sudo', 'doas']);

const PRIVILEGE_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-u',
  '--user',
  '-g',
  '--group',
  '-h',
  '--host',
  '-p',
  '--prompt',
  '-C',
  '--close-from',
  '-T',
  '--command-timeout',
  '-U',
  '--other-user',
  '-r',
  '--role',
  '-t',
  '--type',
]);

const NESTED_SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'ash']);

const LAUNCH_WRAPPERS: ReadonlySet<string> = new Set([
  'env',
  'command',
  'exec',
  'nohup',
  'builtin',
  'nice',
]);

const WRAPPER_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-u',
  '--unset',
  '-C',
  '--chdir',
  '-S',
  '--split-string',
  '-a',
  '-n',
  '--adjustment',
]);

const SYSTEMCTL_DANGEROUS_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'poweroff',
  'reboot',
  'halt',
  'kexec',
]);

const SYSTEMCTL_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-H', '--host', '-M', '--machine']);

const DD_SAFE_DEVICE_TARGETS: ReadonlySet<string> = new Set([
  '/dev/null',
  '/dev/zero',
  '/dev/full',
  '/dev/random',
  '/dev/urandom',
  '/dev/stdin',
  '/dev/stdout',
  '/dev/stderr',
]);

const INERT_COMMANDS: ReadonlySet<string> = new Set([
  'cd',
  'export',
  'declare',
  'typeset',
  'local',
  'readonly',
  'set',
  'unset',
  'rm',
  'test',
  '[',
  'echo',
  'printf',
  'true',
  ':',
  'pwd',
]);

const EXPANSION_NODE_TYPES: ReadonlySet<string> = new Set([
  'command_substitution',
  'process_substitution',
  'expansion',
  'simple_expansion',
]);

const SUBSTITUTION_NODE_TYPES: ReadonlySet<string> = new Set([
  'command_substitution',
  'process_substitution',
]);

interface TopLevelElement {
  readonly statement: BashSyntaxNode;
  connector: string | undefined;
}

export class DangerousCommandAskPermissionPolicyService implements PermissionPolicy {
  readonly name = 'dangerous-command-ask';

  constructor(
    @IBashParserService private readonly bashParser: IBashParserService,
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @IConfigService private readonly config: IConfigService,
    @IAgentRuntimeService private readonly runtimeService: IAgentRuntimeService,
    @ISessionWorkspaceContext private readonly workspaceContext: ISessionWorkspaceContext,
    @ILogService private readonly log?: ILogService,
  ) {}

  async evaluate(context: ResolvedToolExecutionHookContext): Promise<PermissionPolicyResult | undefined> {
    if (!isDangerousCommandGuardEnabled(this.config)) return undefined;
    if (this.modeService.mode === 'auto') return undefined;
    if (context.toolCall.name !== 'Bash') return undefined;
    const command = bashCommandText(context.args);
    const verdicts =
      command === undefined
        ? ([{ kind: 'unanalyzable' }] as const)
        : analyzeSource(command, 0, (source) => this.bashParser.parse(source, PARSE_OPTIONS), false);
    if (!verdicts.some((verdict) => verdict.kind === 'rm')) {
      return synthesize(verdicts, [], this.modeService.mode);
    }
    const eligible = await this.evaluateRmEligibility(verdicts, context);
    return synthesize(verdicts, eligible, this.modeService.mode);
  }

  private async evaluateRmEligibility(
    verdicts: readonly CommandVerdict[],
    context: ResolvedToolExecutionHookContext,
  ): Promise<readonly boolean[]> {
    if (!this.runtimeService.isAvailable(['fs'])) {
      return verdicts.map(() => false);
    }
    let lease: RuntimeLease | undefined;
    try {
      lease = this.runtimeService.acquire(['fs']);
      const runtime = lease.runtime;
      const view = new RuntimeWorkspaceView(runtime, this.workspaceContext);
      const initialBase =
        view.workDir === '' ? undefined : view.resolve(bashCwd(context.args) ?? view.workDir);
      const env = {
        view,
        fs: runtime.fs,
        initialBase,
        cdpathSet: isNonEmpty(process.env['CDPATH']),
        log: this.log,
      };
      return await Promise.all(
        verdicts.map((verdict): Promise<boolean> =>
          verdict.kind === 'rm' ? isRmEligible(verdict.candidate, env) : Promise.resolve(false),
        ),
      );
    } catch (error) {
      this.log?.warn('dangerous-command-ask: evaluateRmEligibility failed', { error });
      return verdicts.map(() => false);
    } finally {
      lease?.dispose();
    }
  }
}

function synthesize(
  verdicts: readonly CommandVerdict[],
  eligible: readonly boolean[],
  mode: PermissionMode,
): PermissionPolicyResult | undefined {
  const hasEligibleRm = verdicts.some((verdict, index) => verdict.kind === 'rm' && eligible[index]);
  for (let i = 0; i < verdicts.length; i += 1) {
    const verdict = verdicts[i]!;
    if (verdict.kind === 'dangerous') {
      return { kind: 'ask', reason: { dangerous_command: verdict.command } };
    }
    if (verdict.kind === 'rm') {
      if (eligible[i]) continue;
      return { kind: 'ask', reason: { dangerous_command: 'rm -rf' } };
    }
    if (hasEligibleRm) return { kind: 'ask', reason: { dangerous_command: 'rm -rf' } };
    if (mode === 'yolo') return undefined;
    return { kind: 'ask', reason: { unanalyzable_command: true } };
  }
  return undefined;
}

function bashCommandText(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const command = (args as { readonly command?: unknown }).command;
  return typeof command === 'string' ? command : undefined;
}

function bashCwd(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const cwd = (args as { readonly cwd?: unknown }).cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
}

function isNonEmpty(value: string | undefined): boolean {
  return typeof value === 'string' && value.length > 0;
}

function analyzeSource(
  source: string,
  depth: number,
  parse: (source: string) => BashParseResult,
  wrapped: boolean,
): readonly CommandVerdict[] {
  const parsed = parse(source);
  if (!parsed.ok || parsed.hasError) return [{ kind: 'unanalyzable' }];
  const commands: BashSyntaxNode[] = [];
  collectCommands(parsed.root, commands);
  const verdicts: CommandVerdict[] = [];
  for (const command of commands) {
    verdicts.push(...analyzeCommand(command, depth, parse, parsed.root, wrapped));
  }
  return verdicts;
}

function collectCommands(node: BashSyntaxNode, out: BashSyntaxNode[]): void {
  if (node.type === 'command') out.push(node);
  for (const child of node.children) collectCommands(child, out);
}

function analyzeCommand(
  command: BashSyntaxNode,
  depth: number,
  parse: (source: string) => BashParseResult,
  root: BashSyntaxNode,
  wrapped: boolean,
): readonly CommandVerdict[] {
  const nameIndex = command.children.findIndex((child) => child.type === 'command_name');
  const nameNode = nameIndex >= 0 ? command.children[nameIndex] : undefined;
  const nameWord = nameNode?.children.find((child) => child.isNamed);
  const rawName = nameWord === undefined ? undefined : literalText(nameWord);
  if (rawName === undefined || rawName.length === 0) return [{ kind: 'unanalyzable' }];
  const args: string[] = [];
  let dropped = false;
  for (const child of command.children.slice(nameIndex + 1)) {
    if (SKIPPED_COMMAND_CHILDREN.has(child.type)) continue;
    const value = literalText(child);
    if (value === undefined) {
      dropped = true;
    } else if (value.length > 0) {
      args.push(value);
    }
  }
  return analyzeInvocation(
    normalizeCommandName(rawName),
    args,
    dropped,
    depth,
    parse,
    root,
    wrapped,
    command,
  );
}

function analyzeInvocation(
  name: string,
  args: readonly string[],
  dropped: boolean,
  depth: number,
  parse: (source: string) => BashParseResult,
  root: BashSyntaxNode,
  wrapped: boolean,
  command: BashSyntaxNode,
): readonly CommandVerdict[] {
  if (PRIVILEGE_WRAPPERS.has(name)) {
    const rest = dropLeadingOptions(args, PRIVILEGE_VALUE_OPTIONS);
    const inner = rest[0];
    if (inner === undefined) return dropped ? [{ kind: 'unanalyzable' }] : [];
    return analyzeInvocation(
      normalizeCommandName(inner),
      rest.slice(1),
      dropped,
      depth,
      parse,
      root,
      true,
      command,
    );
  }
  if (LAUNCH_WRAPPERS.has(name)) {
    if (name === 'command') {
      for (const arg of args) {
        if (arg === '--') break;
        if (arg === '-') continue;
        if (!arg.startsWith('-')) break;
        if (/[vV]/.test(arg)) return [];
      }
    }
    const rest = dropLaunchWrapperOperands(name, args);
    const inner = rest[0];
    if (inner === undefined) return dropped ? [{ kind: 'unanalyzable' }] : [];
    return analyzeInvocation(
      normalizeCommandName(inner),
      rest.slice(1),
      dropped,
      depth,
      parse,
      root,
      true,
      command,
    );
  }
  if (NESTED_SHELLS.has(name)) {
    let payloadIndex = -1;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!;
      if (arg === '--') break;
      if (/^-[a-zA-Z]+$/.test(arg)) {
        if (arg.includes('c')) payloadIndex = i + 1;
      } else {
        break;
      }
    }
    if (payloadIndex < 0) return dropped ? [{ kind: 'unanalyzable' }] : [];
    const payload = args[payloadIndex];
    if (payload === undefined || depth >= MAX_NESTED_SHELL_DEPTH) {
      return [{ kind: 'unanalyzable' }];
    }
    return analyzeSource(payload, depth + 1, parse, true);
  }
  if (name === 'eval') {
    if (args.length === 0) return dropped ? [{ kind: 'unanalyzable' }] : [];
    if (dropped || depth >= MAX_NESTED_SHELL_DEPTH) return [{ kind: 'unanalyzable' }];
    return analyzeSource(args.join(' '), depth + 1, parse, true);
  }
  if (name === 'busybox') {
    const applet = args[0];
    if (applet === undefined || applet.startsWith('-')) {
      return dropped ? [{ kind: 'unanalyzable' }] : [];
    }
    return analyzeInvocation(
      normalizeCommandName(applet),
      args.slice(1),
      dropped,
      depth,
      parse,
      root,
      true,
      command,
    );
  }
  if (SIMPLE_DANGEROUS_COMMANDS.has(name) || name.startsWith('mkfs.')) {
    return [{ kind: 'dangerous', command: name }];
  }
  if (name === 'init' || name === 'telinit') {
    if (args.some((arg) => arg === '0' || arg === '6')) {
      return [{ kind: 'dangerous', command: name }];
    }
    return dropped ? [{ kind: 'unanalyzable' }] : [];
  }
  if (name === 'systemctl') {
    const subcommand = dropLeadingOptions(args, SYSTEMCTL_VALUE_OPTIONS)[0];
    if (subcommand !== undefined && SYSTEMCTL_DANGEROUS_SUBCOMMANDS.has(subcommand)) {
      return [{ kind: 'dangerous', command: `systemctl ${subcommand}` }];
    }
    return dropped ? [{ kind: 'unanalyzable' }] : [];
  }
  if (name === 'dd') {
    for (const arg of args) {
      if (!arg.startsWith('of=')) continue;
      const target = arg.slice('of='.length);
      if (target.startsWith('/dev/') && !DD_SAFE_DEVICE_TARGETS.has(target)) {
        return [{ kind: 'dangerous', command: 'dd' }];
      }
    }
    return dropped ? [{ kind: 'unanalyzable' }] : [];
  }
  if (name === 'rm') {
    let recursive = false;
    let force = false;
    const operands: string[] = [];
    let optionsEnded = false;
    for (const arg of args) {
      if (!optionsEnded && arg === '--') {
        optionsEnded = true;
        continue;
      }
      if (optionsEnded) {
        operands.push(arg);
        continue;
      }
      if (arg === '--recursive') {
        recursive = true;
      } else if (arg === '--force') {
        force = true;
      } else if (/^-[a-zA-Z]+$/.test(arg)) {
        if (/[rR]/.test(arg)) recursive = true;
        if (arg.includes('f')) force = true;
      } else {
        operands.push(arg);
      }
    }
    if (recursive && force) {
      const cdChain = wrapped ? undefined : deriveCdChain(root, command);
      return [{ kind: 'rm', candidate: { operands, dropped, cdChain } }];
    }
    return dropped ? [{ kind: 'unanalyzable' }] : [];
  }
  return [];
}

function deriveCdChain(
  root: BashSyntaxNode,
  rmCommand: BashSyntaxNode,
): readonly string[] | undefined {
  const elements = flattenTopLevel(root);
  const rmIndex = elements.findIndex(
    (element) =>
      element.statement === rmCommand ||
      (element.statement.type === 'redirected_statement' &&
        element.statement.children.some((child) => child === rmCommand)),
  );
  if (rmIndex < 0) return undefined;
  if (elements[rmIndex]!.connector === '&') return undefined;
  if (containsNodeType(elements[rmIndex]!.statement, SUBSTITUTION_NODE_TYPES)) return undefined;
  const chain: string[] = [];
  let hasRelativeCd = false;
  let firstCdIndex = -1;
  for (let i = 0; i < rmIndex; i += 1) {
    const element = elements[i]!;
    if (!isInertStatement(element.statement)) return undefined;
    const cdOperand = literalCdOperand(element.statement);
    if (cdOperand === null) return undefined;
    if (cdOperand === undefined) continue;
    if (firstCdIndex < 0) firstCdIndex = i;
    chain.push(cdOperand);
    if (!cdOperand.startsWith('/')) hasRelativeCd = true;
    if (i > 0 && elements[i - 1]!.connector === '||') return undefined;
  }
  if (firstCdIndex >= 0) {
    for (let i = firstCdIndex; i < rmIndex; i += 1) {
      if (elements[i]!.connector !== '&&') return undefined;
    }
  }
  if (hasRelativeCd && assignsCdpath(elements, rmIndex)) return undefined;
  return chain;
}

function flattenTopLevel(root: BashSyntaxNode): TopLevelElement[] {
  const elements: TopLevelElement[] = [];
  flattenSequenceNode(root, elements);
  return elements;
}

function flattenSequenceNode(node: BashSyntaxNode, elements: TopLevelElement[]): void {
  for (const child of node.children) {
    if (child.type === 'list') {
      flattenSequenceNode(child, elements);
      continue;
    }
    if (!child.isNamed) {
      const connector = connectorOf(child.text);
      if (connector !== undefined && elements.length > 0) {
        elements.at(-1)!.connector = connector;
      }
      continue;
    }
    if (child.type === 'comment') continue;
    if (elements.length > 0 && elements.at(-1)!.connector === undefined) {
      elements.at(-1)!.connector = ';';
    }
    elements.push({ statement: child, connector: undefined });
  }
}

function connectorOf(text: string): string | undefined {
  if (text === '&&' || text === '||' || text === '&' || text === ';') return text;
  if (text === ';;' || text === ';&' || text === ';;&' || text === '\n') return ';';
  return undefined;
}

function isInertStatement(statement: BashSyntaxNode): boolean {
  switch (statement.type) {
    case 'declaration_command':
    case 'unset_command':
    case 'test_command':
    case 'variable_assignment':
      return !containsNodeType(statement, EXPANSION_NODE_TYPES);
    case 'command': {
      if (containsNodeType(statement, EXPANSION_NODE_TYPES)) return false;
      const nameIndex = statement.children.findIndex((child) => child.type === 'command_name');
      const nameNode = nameIndex >= 0 ? statement.children[nameIndex] : undefined;
      const nameWord = nameNode?.children.find((child) => child.isNamed);
      const rawName = nameWord === undefined ? undefined : literalText(nameWord);
      if (rawName === undefined || !INERT_COMMANDS.has(normalizeCommandName(rawName))) {
        return false;
      }
      for (const child of statement.children.slice(nameIndex + 1)) {
        if (SKIPPED_COMMAND_CHILDREN.has(child.type)) continue;
        if (literalText(child) === undefined) return false;
      }
      return true;
    }
    default:
      return false;
  }
}

function literalCdOperand(statement: BashSyntaxNode): string | null | undefined {
  if (statement.type !== 'command') return undefined;
  const nameIndex = statement.children.findIndex((child) => child.type === 'command_name');
  const nameNode = nameIndex >= 0 ? statement.children[nameIndex] : undefined;
  const nameWord = nameNode?.children.find((child) => child.isNamed);
  const rawName = nameWord === undefined ? undefined : literalText(nameWord);
  if (rawName === undefined || normalizeCommandName(rawName) !== 'cd') return undefined;
  const operands: string[] = [];
  for (const child of statement.children.slice(nameIndex + 1)) {
    if (SKIPPED_COMMAND_CHILDREN.has(child.type)) continue;
    const value = literalText(child);
    if (value === undefined || value.length === 0) return null;
    operands.push(value);
  }
  if (operands.length !== 1) return null;
  const operand = operands[0]!;
  if (operand === '-' || operand.startsWith('-')) return null;
  for (const segment of operand.split('/')) {
    if (segment === '..') return null;
  }
  return operand;
}

function assignsCdpath(elements: readonly TopLevelElement[], rmIndex: number): boolean {
  for (let i = 0; i < rmIndex; i += 1) {
    if (containsCdpathAssignment(elements[i]!.statement)) return true;
  }
  return false;
}

function containsCdpathAssignment(node: BashSyntaxNode): boolean {
  if (node.type === 'variable_assignment') {
    const name = node.children.find((child) => child.type === 'variable_name');
    if (name?.text === 'CDPATH') return true;
  }
  return node.children.some((child) => containsCdpathAssignment(child));
}

function containsNodeType(node: BashSyntaxNode, types: ReadonlySet<string>): boolean {
  if (types.has(node.type)) return true;
  return node.children.some((child) => containsNodeType(child, types));
}

function normalizeCommandName(raw: string): string {
  let name = raw;
  const separator = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (separator >= 0) name = name.slice(separator + 1);
  name = name.toLowerCase();
  if (name.endsWith('.exe')) name = name.slice(0, -'.exe'.length);
  return name;
}

function dropLeadingOptions(args: readonly string[], valueOptions: ReadonlySet<string>): string[] {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--') return args.slice(i + 1);
    if (arg === '-' || !arg.startsWith('-')) return args.slice(i);
    if (!arg.includes('=') && valueOptions.has(arg)) i += 1;
  }
  return [];
}

function dropLaunchWrapperOperands(name: string, args: readonly string[]): string[] {
  let rest = dropLeadingOptions(args, WRAPPER_VALUE_OPTIONS);
  if (name === 'env') {
    let i = rest[0] === '-' ? 1 : 0;
    while (i < rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[i]!)) i += 1;
    rest = rest.slice(i);
  }
  return rest;
}

function literalText(node: BashSyntaxNode): string | undefined {
  switch (node.type) {
    case 'word': {
      const raw = node.text;
      if (UNSAFE_OPERAND.test(raw)) return undefined;
      const unescaped = raw.replaceAll(/\\(.)/gs, '$1');
      return UNSAFE_OPERAND.test(unescaped) ? undefined : unescaped;
    }
    case 'number':
      return node.text;
    case 'raw_string': {
      if (node.text.length < 2) return undefined;
      const value = node.text.slice(1, -1);
      return UNSAFE_OPERAND.test(value) ? undefined : value;
    }
    case 'string': {
      let value = '';
      for (const child of node.children) {
        if (child.type === 'string_content') {
          value += child.text;
        } else if (child.isNamed) {
          return undefined;
        }
      }
      return UNSAFE_OPERAND.test(value) ? undefined : value;
    }
    default:
      return undefined;
  }
}
