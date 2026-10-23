import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ProjectLocalConfigLoad } from './projectLocalConfigReader';

export type {
  ProjectLocalConfigDiagnostic,
  ProjectLocalConfigFs,
  ProjectLocalConfigLoad,
} from './projectLocalConfigReader';

export interface IProjectLocalConfigService {
  readonly _serviceBrand: undefined;

  readAdditionalDirs(workDir: string): Promise<ProjectLocalConfigLoad>;
  resolveAdditionalDirs(baseDir: string, additionalDirs: readonly string[]): Promise<string[]>;
  appendAdditionalDir(workDir: string, inputPath: string): Promise<ProjectLocalConfigLoad>;
}

export const IProjectLocalConfigService: ServiceIdentifier<IProjectLocalConfigService> =
  createDecorator<IProjectLocalConfigService>('projectLocalConfigService');
