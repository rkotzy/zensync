import { initializeDb } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import { Env } from '@/interfaces/env.interface';
import { SlackConnection, slackConnection, subscription } from '@/lib/schema';
import { SlackResponse } from '@/interfaces/slack-api.interface';
import { EdgeWithExecutionContext } from '@logtail/edge/dist/es6/edgeWithExecutionContext';
import { createStripeAccount } from '@/lib/utils';

export async function slackConnectionCreated(
  requestJson: any,
  env: Env,
  logger: EdgeWithExecutionContext
) {
  const connectionDetails: SlackConnection = requestJson.connectionDetails;
  if (!connectionDetails) {
    logger.error('No connection details found');
    return;
  }

  // Get idempotency key from request
  const idempotencyKey = requestJson.idempotencyKey;
  if (!idempotencyKey) {
    logger.error('No idempotency key found');
    return;
  }

  try {
    // Get name and email of Slack user (can this be passed from the callback)
    const email = await getAuthedConnectionUserEmail(connectionDetails, logger);

    // Create customer in Stripe
    const stripeAccount = await createStripeAccount(
      connectionDetails.name,
      email,
      env,
      idempotencyKey,
      logger
    );

    // Update Slack connection in database
    const db = initializeDb(env);

    const databaseSubscription = await db
      .insert(subscription)
      .values({
        stripeSubscriptionId: stripeAccount.subscriptionId,
        stripeProductId: env.DEFAULT_STRIPE_PRODUCT_ID,
        // Conditionally include startedAt only if currentPeriodStart exists
        ...(stripeAccount.currentPeriodStart
          ? { periodStart: new Date(stripeAccount.currentPeriodStart * 1000) }
          : {}),
        // Conditionally include endsAt only if currentPeriodEnd exists
        ...(stripeAccount.currentPeriodEnd
          ? { periodEnd: new Date(stripeAccount.currentPeriodEnd * 1000) }
          : {})
      })
      .onConflictDoNothing()
      .returning({ insertedId: subscription.id });

    // If that failed for some reason throw an error, it's safe to retry
    if (!databaseSubscription || databaseSubscription.length === 0) {
      logger.error('Error upserting subscription');
      throw new Error('Error upserting subscription');
    }

    await db
      .update(slackConnection)
      .set({
        stripeCustomerId: stripeAccount.customerId,
        subscriptionId: databaseSubscription[0].insertedId
      })
      .where(eq(slackConnection.id, connectionDetails.id));
  } catch (error) {
    logger.error('Error in slackConnectionCreated:', error);
    throw new Error('Error in slackConnectionCreated');
  }
}

async function getAuthedConnectionUserEmail(
  connection: SlackConnection,
  logger: EdgeWithExecutionContext
): Promise<string | undefined> {
  try {
    const response = await fetch(
      `https://slack.com/api/users.info?user=${connection.authedUserId}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Bearer ${connection.token}`
        }
      }
    );

    const responseData = (await response.json()) as SlackResponse;

    if (!responseData.ok) {
      return undefined;
    }

    return responseData.user.profile?.email || undefined;
  } catch (error) {
    logger.error(`Error in getSlackUserEmail: ${error}`);
    throw error;
  }
}
