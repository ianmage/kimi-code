import { describe, expect, it } from 'vitest';

import { ErrorCodes as PublicErrorCodes } from '@moonshot-ai/agent-core-v2';
import { isErrorCode, type ErrorDomain } from '#/_base/errors/codes';
import { ErrorCodes, WorkspaceErrors } from '#/errors';

describe('WorkspaceErrors', () => {
  it('declares the additional-dir codes', () => {
    expect(WorkspaceErrors.codes.ADDITIONAL_DIR_UNAVAILABLE).toBe(
      'workspace.additional_dir_unavailable',
    );
    expect(WorkspaceErrors.codes.ADDITIONAL_DIR_PERSIST_BLOCKED).toBe(
      'workspace.additional_dir_persist_blocked',
    );
  });

  it('keeps both codes distinct from the generic config failure', () => {
    expect(WorkspaceErrors.codes.ADDITIONAL_DIR_UNAVAILABLE).not.toBe(ErrorCodes.CONFIG_INVALID);
    expect(WorkspaceErrors.codes.ADDITIONAL_DIR_PERSIST_BLOCKED).not.toBe(ErrorCodes.CONFIG_INVALID);
  });

  it('registers both codes', () => {
    expect(isErrorCode(WorkspaceErrors.codes.ADDITIONAL_DIR_UNAVAILABLE)).toBe(true);
    expect(isErrorCode(WorkspaceErrors.codes.ADDITIONAL_DIR_PERSIST_BLOCKED)).toBe(true);
  });

  it('exposes both codes through the aggregate', () => {
    expect(ErrorCodes.ADDITIONAL_DIR_UNAVAILABLE).toBe('workspace.additional_dir_unavailable');
    expect(ErrorCodes.ADDITIONAL_DIR_PERSIST_BLOCKED).toBe('workspace.additional_dir_persist_blocked');
  });

  it('satisfies the error domain contract', () => {
    const domain: ErrorDomain = WorkspaceErrors;
    expect(domain.codes).toBe(WorkspaceErrors.codes);
  });
});

describe('ErrorCodes public entry', () => {
  it('exposes both additional-dir codes from the package root', () => {
    expect(PublicErrorCodes.ADDITIONAL_DIR_UNAVAILABLE).toBe(
      'workspace.additional_dir_unavailable',
    );
    expect(PublicErrorCodes.ADDITIONAL_DIR_PERSIST_BLOCKED).toBe(
      'workspace.additional_dir_persist_blocked',
    );
  });
});
