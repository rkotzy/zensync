import { uploadFilesToZendesk } from './uploadFiles';
import { handleMessageFromSlack } from './handleSlackMessage';
import { slackConnectionCreated } from './slackConnectionCreated';
import { stripeSubscriptionChanged } from './subscriptionChanged';
import { Env } from '@/interfaces/env.interface';
import { Logtail } from '@logtail/edge';

export class QueueMessageHandler {
  async handle(
    batch: MessageBatch<any>,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    // Set up logger right away
    const baseLogger = new Logtail(env.BETTER_STACK_SOURCE_TOKEN);
    const logger = baseLogger.withExecutionContext(ctx);

    try {
      for (const message of batch.messages) {
        // MessageBatch has a `queue` property we can switch on
        switch (batch.queue) {
          case 'upload-files-to-zendesk':
            await uploadFilesToZendesk(message.body, env, logger);
            break;
          case 'process-slack-messages':
            await handleMessageFromSlack(message.body, env, logger);
            break;
          case 'slack-connection-created':
            await slackConnectionCreated(message.body, env, logger);
            break;
          case 'stripe-subscription-changed':
            await stripeSubscriptionChanged(message.body, env, logger);
            break;
          case 'dlq':
            // Handle dead-letter queue messages
            break;
          default:
            logger.warn(`Unknown queue: ${batch.queue}`);
        }
      }
    } catch (e) {
      logger.error(`Error processing queue message on ${batch.queue}`);
      throw e;
    }
  }
}
