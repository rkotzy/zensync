import { Env } from '@/interfaces/env.interface';
import { SlackConnection } from '@/lib/schema';
import { EdgeWithExecutionContext } from '@logtail/edge/dist/es6/edgeWithExecutionContext';

export async function slackConnectionCreated(
  requestJson: any,
  env: Env,
  logger: EdgeWithExecutionContext
) {
  logger.info(JSON.stringify(requestJson, null, 2));

  const connectionDetails: SlackConnection = requestJson.connectionDetails;
  if (!connectionDetails) {
    logger.error('No connection details found');
    return;
  }

  // Get name and email of Slack user (can this be passed from the callback)

  // Get idempotency key from request

  // Create customer in Stripe

  // Update Slack connection in database
}
