import { forumLinkStateNotice } from '#/tui/controllers/forum-link';
import { loadCredential } from '#/tui/controllers/forum-link/credential';

import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

const FORUM_USAGE = 'Usage: /forum or /forum stop';

type ForumIntent = 'publish' | 'stop' | 'invalid';

/**
 * `/forum` — idempotent publish, `/forum stop` — explicit unpublish. The
 * command owns argument parsing, intent gating, session validation, and
 * credential resolution (zero network on failure); the controller owns the
 * publish orchestration itself.
 */
export async function handleForumCommand(host: SlashCommandHost, args: string): Promise<void> {
  const intent = parseForumIntent(args);
  if (intent === 'invalid') {
    host.showError(FORUM_USAGE);
    return;
  }

  const controller = host.forumLink;
  if (intent === 'stop') {
    if (controller !== undefined && controller.state !== 'detached') {
      await controller.stop();
    }
    host.showStatus(forumLinkStateNotice('detached'));
    return;
  }

  if (controller !== undefined && controller.state !== 'detached') {
    host.showStatus(forumLinkStateNotice(controller.state));
    return;
  }

  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const credential = loadCredential();
  if (!credential.ok) {
    host.showError(credential.hint);
    return;
  }

  await publishForumLink(host, credential.url, credential.token);
}

function parseForumIntent(args: string): ForumIntent {
  const trimmed = args.trim();
  if (trimmed === '') return 'publish';
  if (trimmed.toLowerCase() === 'stop') return 'stop';
  return 'invalid';
}

async function publishForumLink(host: SlashCommandHost, url: string, token: string): Promise<void> {
  const controller = host.ensureForumLink();
  const result = await controller.start({ url, token });
  if (!result.ok) {
    if (result.reason === 'connect-failed') {
      host.showError(`Forum Link publish failed: ${formatErrorMessage(result.error)}`);
    } else if (result.reason === 'no-session') {
      host.showError(NO_ACTIVE_SESSION_MESSAGE);
    } else {
      host.showError(`Forum Link publish failed: ${result.reason}`);
    }
    await controller.stop();
    return;
  }
  host.showStatus(forumLinkStateNotice('published'));
}
