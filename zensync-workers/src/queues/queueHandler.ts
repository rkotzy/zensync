import { uploadFilesToZendesk } from './uploadFiles';
import { handleMessageFromSlack } from './handleSlackMessage';
import { slackConnectionCreated } from './slackConnectionCreated';
import { stripeSubscriptionChanged } from './subscriptionChanged';
import { slackAppUninstalled } from './slackAppUninstalled';
import { Env } from '@/interfaces/env.interface';
import { safeLog } from '@/lib/logging';

export class QueueMessageHandler {
  async handle(
    batch: MessageBatch<any>,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    try {
      for (const message of batch.messages) {
        // MessageBatch has a `queue` property we can switch on
        switch (batch.queue) {
          case 'upload-files-to-zendesk':
            await uploadFilesToZendesk(message.body, env);
            break;
          case 'process-slack-messages':
            await handleMessageFromSlack(message.body, env);
            break;
          case 'slack-connection-created':
            await slackConnectionCreated(message.body, env);
            break;
          case 'stripe-subscription-changed':
            await stripeSubscriptionChanged(message.body, env);
            break;
          case 'slack-app-uninstalled':
            await slackAppUninstalled(message.body, env);
            break;
          case 'dlq':
            safeLog('error', message.body);
            break;
          default:
            safeLog('warn', `Unknown queue: ${batch.queue}`);
        }
      }
    } catch (error) {
      safeLog(
        'error',
        `Error processing queue message on ${batch.queue}`,
        error
      );
      throw error;
    }
  }
}
