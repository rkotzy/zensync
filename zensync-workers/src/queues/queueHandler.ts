import { uploadFilesToZendesk } from './uploadFiles';
import { handleMessageFromSlack } from './handleSlackMessage';
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

    logger.info('Queue consumer started!');
    try {
      for (const message of batch.messages) {
        // MessageBatch has a `queue` property we can switch on
        switch (batch.queue) {
          case 'upload-files-to-zendesk':
            logger.info('Processing upload-files-to-zendesk queue');
            await uploadFilesToZendesk(message.body, env, logger);
            break;
          case 'process-slack-messages':
            logger.info('Processing upload-files-to-zendesk queue');
            await handleMessageFromSlack(message.body, env, logger);
            break;
          case 'dlq':
            // Handle dead-letter queue messages
            break;
          default:
            logger.info(`Unknown queue: ${batch.queue}`);
        }
      }
    } catch (e) {
      logger.info(`Error processing queue message on ${batch.queue}`);
      logger.error(e);
      throw e;
    }
  }
}
