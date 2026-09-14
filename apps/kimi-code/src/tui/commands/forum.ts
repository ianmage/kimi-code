import { loadCredential } from '#/tui/controllers/forum-link/credential';
import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

/**
 * `/forum` — publish this session to the Forum Link hub, or unpublish when
 * already published (toggle). The command owns the toggle decision, session
 * validation, and credential resolution (zero network on failure); the
 * controller owns the publish orchestration itself.
 */
export async function handleForumCommand(host: SlashCommandHost): Promise<void> {
  if (host.forumLink !== undefined && host.forumLink.state !== 'detached') {
    await host.forumLink.stop();
    host.showStatus('Forum Link: unpublished');
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

  const controller = host.ensureForumLink();
  const result = await controller.start({ url: credential.url, password: credential.password });
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
  host.showStatus('Forum Link: published');
}
