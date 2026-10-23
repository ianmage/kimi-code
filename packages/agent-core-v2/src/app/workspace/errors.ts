import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const WorkspaceErrors = {
  codes: {
    WORKSPACE_NOT_FOUND: 'workspace.not_found',
    ADDITIONAL_DIR_UNAVAILABLE: 'workspace.additional_dir_unavailable',
    ADDITIONAL_DIR_PERSIST_BLOCKED: 'workspace.additional_dir_persist_blocked',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(WorkspaceErrors);
