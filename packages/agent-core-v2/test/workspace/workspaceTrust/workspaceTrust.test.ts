import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { ILogService } from '#/_base/log/log';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IConfigService } from '#/app/config/config';
import type {
  IProjectLocalConfigService,
  ProjectLocalConfigDiagnostic,
  ProjectLocalConfigLoad,
} from '#/app/projectLocalConfig/projectLocalConfig';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import type { IWorkspaceSkillCatalog } from '#/features/skill/workspace/workspaceSkillCatalog';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import { IWorkspaceStateService } from '#/workspace/state/workspaceState';
import type { IWorkspaceAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoader';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import type { IWorkspaceInstructionsService } from '#/workspace/workspaceInstructions/workspaceInstructions';
import {
  IWorkspaceTrust,
  type WorkspaceTrustChange,
} from '#/workspace/workspaceTrust/workspaceTrust';
import {
  TRUST_WORKSPACE_ENV,
  WorkspaceTrustService,
  workspaceTrustTrustedKey,
} from '#/workspace/workspaceTrust/workspaceTrustService';
import { WorkspaceTrustDisclosureService } from '#/workspace/workspaceTrust/trustDisclosureService';
import {
  deleteWorkspaceTrust,
  readWorkspaceTrust,
  writeWorkspaceTrust,
} from '#/workspace/workspaceTrust/trustRecord';

import { stubBootstrap } from '../../app/bootstrap/stubs';
import { registerStateServices } from '../../state/stubs';

describe('WorkspaceTrustService', () => {
  let homeDir: string;
  let cwd: string;
  let disposables: DisposableStore;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'kimi-workspace-trust-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'kimi-workspace-trust-cwd-'));
    disposables = new DisposableStore();
  });

  afterEach(async () => {
    disposables.dispose();
    await Promise.all([
      rm(homeDir, { recursive: true, force: true }),
      rm(cwd, { recursive: true, force: true }),
    ]);
  });

  function createService(
    root: string,
    events?: WorkspaceTrustChange[],
    env: NodeJS.ProcessEnv = {},
  ): { service: IWorkspaceTrust; states: IWorkspaceStateService } {
    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        registerStateServices(reg);
        reg.definePartialInstance(IWorkspaceContext, { cwd: root });
        reg.defineInstance(IBootstrapService, stubBootstrap(homeDir, env));
        reg.defineInstance(
          IAtomicDocumentStore,
          new JsonAtomicDocumentStore(new FileStorageService(homeDir)),
        );
        reg.defineInstance(ITelemetryService, noopTelemetryService);
        reg.define(IWorkspaceTrust, WorkspaceTrustService);
      },
    });
    const service = ix.get(IWorkspaceTrust);
    if (events !== undefined) {
      service.onDidChange((change) => events.push(change));
    }
    return { service, states: ix.get(IWorkspaceStateService) };
  }

  it('defaults to untrusted when no marker exists', async () => {
    const { service } = createService(cwd);
    await service.ready;

    expect(service.isTrusted()).toBe(false);
    expect(await service.get()).toBe(false);
  });

  it('trusts the workspace when KIMI_CODE_TRUST_WORKSPACE is set', async () => {
    const { service } = createService(cwd, undefined, {
      [TRUST_WORKSPACE_ENV]: '1',
    });
    await service.ready;

    expect(service.isTrusted()).toBe(true);
    expect(await service.get()).toBe(true);
  });

  it('ignores KIMI_CODE_TRUST_WORKSPACE values that do not parse as true', async () => {
    const { service } = createService(cwd, undefined, {
      [TRUST_WORKSPACE_ENV]: '0',
    });
    await service.ready;

    expect(service.isTrusted()).toBe(false);
    expect(await service.get()).toBe(false);
  });

  it('keeps persistence semantics under KIMI_CODE_TRUST_WORKSPACE', async () => {
    const events: WorkspaceTrustChange[] = [];
    const { service, states } = createService(cwd, events, {
      [TRUST_WORKSPACE_ENV]: '1',
    });
    await service.ready;

    await service.trust();
    expect(states.get(workspaceTrustTrustedKey)).toBe(true);

    await service.untrust();
    expect(states.get(workspaceTrustTrustedKey)).toBe(false);
    expect(service.isTrusted()).toBe(true);
    expect(events).toEqual([{ trusted: true }, { trusted: false }]);
  });

  it('trust() flips the state, fires once, and stays idempotent', async () => {
    const events: WorkspaceTrustChange[] = [];
    const { service } = createService(cwd, events);
    await service.ready;

    await service.trust();
    await service.trust();

    expect(service.isTrusted()).toBe(true);
    expect(await service.get()).toBe(true);
    expect(events).toEqual([{ trusted: true }]);
  });

  it('untrust() revokes the state and both directions stay idempotent', async () => {
    const events: WorkspaceTrustChange[] = [];
    const { service } = createService(cwd, events);
    await service.ready;

    await service.untrust();
    await service.trust();
    await service.untrust();
    await service.untrust();

    expect(service.isTrusted()).toBe(false);
    expect(events).toEqual([{ trusted: true }, { trusted: false }]);
  });

  it('keeps the marker across a restart', async () => {
    const { service: first } = createService(cwd);
    await first.ready;
    await first.trust();

    const { service: second } = createService(cwd);
    await second.ready;

    expect(second.isTrusted()).toBe(true);
  });

  it('migrates a legacy Windows trust marker to the canonical key', async () => {
    const docs = new JsonAtomicDocumentStore(new FileStorageService(homeDir));
    const root = 'C:\\Users\\Foo\\Repo';
    const record = { root, trustedAt: 1 };
    await docs.set('workspace-trust', encodeWorkDirKey(root), record);

    expect(await readWorkspaceTrust(docs, root)).toBe(true);
    await expect(
      docs.get('workspace-trust', encodeWorkDirKey('c:/users/foo/repo')),
    ).resolves.toEqual(record);
  });

  it('shares one trust key across UNC and drive-letter spelling variants', async () => {
    const docs = new JsonAtomicDocumentStore(new FileStorageService(homeDir));
    await writeWorkspaceTrust(docs, '//server/share/repo', 1);
    expect(await readWorkspaceTrust(docs, '\\\\SERVER\\SHARE\\REPO')).toBe(true);
    expect(await readWorkspaceTrust(docs, '//Server/Share/Repo')).toBe(true);

    await writeWorkspaceTrust(docs, 'C:\\Users\\Foo\\Repo', 2);
    expect(await readWorkspaceTrust(docs, 'c:/users/foo/repo')).toBe(true);
  });

  it('deletes both canonical and legacy trust markers', async () => {
    const docs = new JsonAtomicDocumentStore(new FileStorageService(homeDir));
    const root = 'C:\\Users\\Foo\\Repo';
    const legacyKey = encodeWorkDirKey(root);
    await docs.set('workspace-trust', legacyKey, { root, trustedAt: 1 });
    await writeWorkspaceTrust(docs, root, 2);

    await deleteWorkspaceTrust(docs, root);

    await expect(docs.get('workspace-trust', legacyKey)).resolves.toBeUndefined();
    await expect(readWorkspaceTrust(docs, root)).resolves.toBe(false);
  });

  it('tracks different roots independently', async () => {
    const other = mkdtempSync(join(tmpdir(), 'kimi-workspace-trust-other-'));
    try {
      const { service: first } = createService(cwd);
      await first.ready;
      await first.trust();

      const { service: second } = createService(other);
      await second.ready;

      expect(second.isTrusted()).toBe(false);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('registers the trusted flag into the workspace state container', async () => {
    const { service, states } = createService(cwd);
    await service.ready;

    expect(states.has(workspaceTrustTrustedKey)).toBe(true);
    expect(states.get(workspaceTrustTrustedKey)).toBe(false);

    const seen: boolean[] = [];
    states.onDidChange(workspaceTrustTrustedKey)((value) => seen.push(value));
    await service.trust();
    await service.untrust();

    expect(seen).toEqual([true, false]);
    expect(states.get(workspaceTrustTrustedKey)).toBe(false);
    expect(states.snapshot()['workspaceTrust.trusted']).toBe(false);
  });
});

describe('WorkspaceTrustDisclosureService', () => {
  const UNINSPECTABLE_WARNING = 'Could not inspect additional directory configuration.';

  let root: string;
  let scratchDirs: string[];

  beforeEach(() => {
    root = toPosix(mkdtempSync(join(tmpdir(), 'kimi-trust-disclosure-root-')));
    scratchDirs = [];
  });

  afterEach(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      ...scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    ]);
  });

  function scratchDir(label: string): string {
    const dir = toPosix(mkdtempSync(join(tmpdir(), `kimi-trust-disclosure-${label}-`)));
    scratchDirs.push(dir);
    return dir;
  }

  function loadResult(
    additionalDirs: readonly string[],
    diagnostics: readonly ProjectLocalConfigDiagnostic[],
  ): ProjectLocalConfigLoad {
    return {
      projectRoot: root,
      configPath: join(root, '.kimi-code', 'local.toml'),
      additionalDirs,
      diagnostics,
      source: 'present',
    };
  }

  function createService(load: ProjectLocalConfigLoad): WorkspaceTrustDisclosureService {
    const notFound = (): never => {
      throw new HostFsError(OsFsErrors.codes.OS_FS_NOT_FOUND, 'path does not exist');
    };
    const fs = {
      realpath: async (path: string) => path,
      readText: async () => notFound(),
      stat: async () => notFound(),
      lstat: async () => notFound(),
    };
    const bootstrap = {
      homeDir: scratchDir('home'),
      osHomeDir: scratchDir('os-home'),
      args: { skillDirs: [] },
    };
    return new WorkspaceTrustDisclosureService(
      { cwd: root, workspaceId: 'workspace-1' } as unknown as IWorkspaceContext,
      fs as unknown as IHostFileSystem,
      bootstrap as unknown as IBootstrapService,
      { get: () => true } as unknown as IConfigService,
      { readAdditionalDirs: async () => load } as unknown as IProjectLocalConfigService,
      { ready: Promise.resolve(), isTrusted: () => false } as unknown as IWorkspaceTrust,
      {
        ready: Promise.resolve(),
        catalog: { listSkills: () => [], getSkillRoots: () => [] },
      } as unknown as IWorkspaceSkillCatalog,
      { ready: Promise.resolve() } as unknown as IWorkspaceAgentProfileLoader,
      { entries: () => [] } as unknown as IAgentProfileRegistry,
      { ready: Promise.resolve(), snapshot: {} } as unknown as IWorkspaceInstructionsService,
      { warn: () => {} } as unknown as ILogService,
    );
  }

  it('warns once and discloses no configured dirs when the config file is invalid', async () => {
    const dir = scratchDir('configured');
    const service = createService(
      loadResult([dir], [
        {
          scope: 'file',
          category: 'toml_invalid',
          code: 'storage.decode_failed',
          message: 'Invalid TOML',
        },
      ]),
    );

    const result = await service.describeGatedActivation();

    expect(result.warnings.filter((warning) => warning === UNINSPECTABLE_WARNING)).toHaveLength(1);
    expect(result.additionalDirs).toEqual([]);
    expect(result.additionalDirSources).toEqual([]);
  });

  it('omits a broken entry without warning while keeping the healthy entries', async () => {
    const healthy = scratchDir('healthy');
    const missing = join(tmpdir(), 'kimi-trust-disclosure-missing-entry');
    const service = createService(
      loadResult([healthy], [
        {
          scope: 'entry',
          index: 1,
          entry: missing,
          category: 'missing',
          code: 'os.fs.not_found',
          message: 'path does not exist',
        },
      ]),
    );

    const result = await service.describeGatedActivation();

    expect(result.additionalDirs).toEqual([healthy]);
    expect(result.additionalDirs).not.toContain(missing);
    expect(result.warnings).not.toContain(UNINSPECTABLE_WARNING);
  });

  it('discloses the configured dirs and their source when there are no diagnostics', async () => {
    const dir = scratchDir('configured');
    const service = createService(loadResult([dir], []));

    const result = await service.describeGatedActivation();

    expect(result.additionalDirs).toEqual([dir]);
    expect(result.additionalDirSources).toEqual([join(root, '.kimi-code', 'local.toml')]);
    expect(result.warnings).toEqual([]);
  });
});

function toPosix(path: string): string {
  return path.replaceAll('\\', '/');
}
