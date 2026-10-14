import type { ApprovalHandler, ApprovalRequest, ApprovalResponse } from '@moonshot-ai/kimi-code-sdk';

import { REMOTE_APPROVED_LABEL } from '#/constant/app';

import { adaptApprovalRequest } from './adapter';
import type { ApprovalController } from './controller';
import { consultRemoteApproval } from './remote-approval';

export function createApprovalRequestHandler(
  controller: ApprovalController,
  onResponse?: (request: ApprovalRequest, response: ApprovalResponse) => void,
): ApprovalHandler {
  return async (event): Promise<ApprovalResponse> => {
    try {
      const data = adaptApprovalRequest(event);
      if (
        event.toolName !== 'ExitPlanMode' &&
        event.display.kind !== 'plan_review' &&
        event.display.kind !== 'goal_start' &&
        (await consultRemoteApproval(data))
      ) {
        const response: ApprovalResponse = {
          decision: 'approved',
          selectedLabel: REMOTE_APPROVED_LABEL,
        };
        onResponse?.(event, response);
        return response;
      }
      const response = await controller.show(data);
      onResponse?.(event, response);
      return response;
    } catch {
      const response: ApprovalResponse = {
        decision: 'cancelled',
        feedback: 'approval handler failed',
      };
      onResponse?.(event, response);
      return response;
    }
  };
}
