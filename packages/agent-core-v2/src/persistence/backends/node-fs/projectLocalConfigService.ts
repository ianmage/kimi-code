import { dirname } from 'pathe';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { atomicWrite } from '#/_base/utils/fs';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import {
  classifyAdditionalDirEntry,
  sameAdditionalDir,
  toAdditionalDirError,
  type AdditionalDirEntryClass,
} from '#/app/projectLocalConfig/additionalDirEntry';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import {
  findProjectRoot,
  projectLocalConfigPath,
  readProjectLocalConfig,
  readProjectLocalConfigSource,
  type ProjectLocalConfigDiagnostic,
  type ProjectLocalConfigFs,
  type ProjectLocalConfigLoad,
} from '#/app/projectLocalConfig/projectLocalConfigReader';
import { rewriteAdditionalDirArray } from '#/app/projectLocalConfig/tomlArraySlice';
import { ErrorCodes, Error2 } from '#/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';

export class FileProjectLocalConfigService implements IProjectLocalConfigService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
  ) {}

  readAdditionalDirs(workDir: string): Promise<ProjectLocalConfigLoad> {
    const fs: ProjectLocalConfigFs = {
      readText: (path) => this.fs.readText(path),
      stat: (path) => this.fs.stat(path),
      lstat: (path) => this.fs.lstat(path),
    };

    return readProjectLocalConfig(workDir, { fs, homeDir: this.bootstrap.osHomeDir });
  }

  async resolveAdditionalDirs(
    baseDir: string,
    additionalDirs: readonly string[],
  ): Promise<string[]> {
    const resolvedDirs: string[] = [];

    for (const entry of additionalDirs) {
      const cls = await classifyAdditionalDirEntry(
        entry,
        baseDir,
        this.bootstrap.osHomeDir,
        this.fs,
      );
      if (cls.kind !== 'accepted') throw toAdditionalDirError(cls, entry);
      if (resolvedDirs.some((dir) => sameAdditionalDir(dir, cls.dir))) continue;
      resolvedDirs.push(cls.dir);
    }

    return resolvedDirs;
  }

  async appendAdditionalDir(
    workDir: string,
    inputPath: string,
  ): Promise<ProjectLocalConfigLoad> {
    const projectRoot = await findProjectRoot(workDir, this.fs);
    const configPath = projectLocalConfigPath(projectRoot);

    const newClass = await classifyAdditionalDirEntry(
      inputPath,
      workDir,
      this.bootstrap.osHomeDir,
      this.fs,
    );
    if (newClass.kind !== 'accepted') throw toAdditionalDirError(newClass, inputPath);

    const source = await readProjectLocalConfigSource(configPath, this.fs);
    if (source.kind === 'error') {
      throw new Error2(source.diagnostic.code, source.diagnostic.message, {
        details: { path: configPath },
      });
    }

    const text = source.kind === 'ok' ? source.text : '';
    const entries = source.kind === 'ok' ? source.entries : [];
    const classified: {
      readonly index: number;
      readonly entry: string;
      readonly cls: AdditionalDirEntryClass;
    }[] = [];

    for (const [index, entry] of entries.entries()) {
      classified.push({
        index,
        entry,
        cls: await classifyAdditionalDirEntry(
          entry,
          projectRoot,
          this.bootstrap.osHomeDir,
          this.fs,
        ),
      });
    }

    const kept = classified.filter(
      (item) => !(item.cls.kind === 'unavailable' && item.cls.reason === 'missing'),
    );
    const acceptedDirs = kept.flatMap((item) =>
      item.cls.kind === 'accepted' ? [item.cls.dir] : [],
    );
    const appended = !acceptedDirs.some((dir) => sameAdditionalDir(dir, newClass.dir));
    const nextArray = kept.map((item) => item.entry);
    if (appended) nextArray.push(newClass.dir);

    const additionalDirs = dedupeDirs(acceptedDirs);
    if (appended) additionalDirs.push(newClass.dir);

    const diagnostics: ProjectLocalConfigDiagnostic[] = [];
    for (const item of kept) {
      if (item.cls.kind === 'accepted') continue;
      const error = toAdditionalDirError(item.cls, item.entry);
      diagnostics.push({
        scope: 'entry',
        index: item.index,
        entry: item.entry,
        category: item.cls.reason,
        dir: item.cls.kind === 'unavailable' ? item.cls.dir : undefined,
        code: error.code,
        message: error.message,
      });
    }

    const load: ProjectLocalConfigLoad = {
      projectRoot,
      configPath,
      additionalDirs,
      diagnostics,
      source: 'present',
    };
    if (sameEntries(nextArray, entries)) return load;

    const result = rewriteAdditionalDirArray(text, nextArray);
    if (!result.ok) {
      throw new Error2(
        ErrorCodes.ADDITIONAL_DIR_PERSIST_BLOCKED,
        'workspace.additional_dir could not be rewritten',
        { details: { path: configPath, reason: result.reason } },
      );
    }

    await this.fs.mkdir(dirname(configPath), { recursive: true });
    await this.commit(configPath, result.text);

    return load;
  }

  protected async commit(path: string, text: string): Promise<void> {
    await atomicWrite(path, text);
  }
}

function dedupeDirs(dirs: readonly string[]): string[] {
  const unique: string[] = [];
  for (const dir of dirs) {
    if (unique.some((kept) => sameAdditionalDir(kept, dir))) continue;
    unique.push(dir);
  }
  return unique;
}

function sameEntries(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

registerScopedService(
  LifecycleScope.App,
  IProjectLocalConfigService,
  FileProjectLocalConfigService,
  ScopeActivation.OnScopeCreated,
  'projectLocalConfig',
);
