import {
  attachSubscriptionToSlackConnection,
  createSubscription,
  initializeDb,
  saveSharedSlackChannel,
  getSlackConnection
} from '@/lib/database';
import { Env } from '@/interfaces/env.interface';
import { SlackConnection } from '@/lib/schema-sqlite';
import { createStripeAccount } from '@/lib/utils';
import { safeLog } from '@/lib/logging';
import {
  inviteUserToSharedChannel,
  setUpNewSharedSlackChannel,
  getSlackUserEmail
} from '@/lib/slack-api';

export async function slackConnectionCreated(requestJson: any, env: Env) {
  const connectionId: number = requestJson.connectionId;
  if (!connectionId) {
    safeLog('error', 'No connection Id found', requestJson);
    return;
  }

  try {
    // Init the db
    const db = initializeDb(env);

    const connectionDetails = await getSlackConnection(
      db,
      env,
      'id',
      connectionId
    );

    // Get name and email of Slack user
    const email = await getSlackUserEmail(
      connectionDetails.authedUserId,
      connectionDetails.token
    );

    const parallelTasks = [];

    if (!connectionDetails.supportSlackChannelId) {
      parallelTasks.push(
        setupSupportChannelInSlack(connectionDetails, db, email, env)
      );
    }

    if (!connectionDetails.subscriptionId) {
      parallelTasks.push(
        setupCustomerInStripe(requestJson, connectionDetails, db, email, env)
      );
    }

    await Promise.all(parallelTasks);
  } catch (error) {
    safeLog('error', 'Error in slackConnectionCreated:', error);
    throw error;
  }
}

async function setupSupportChannelInSlack(
  connectionDetails: SlackConnection,
  db: ReturnType<typeof initializeDb>,
  email: string,
  env: Env
) {
  // Check if Slack channel already exists on the connection or data is missing, return
  if (
    connectionDetails.supportSlackChannelId ||
    !connectionDetails.domain ||
    !connectionDetails.authedUserId
  ) {
    return;
  }

  try {
    // Create a new shared channel in Slack
    const sharedChannelId = await setUpNewSharedSlackChannel(
      env,
      connectionDetails.domain
    );

    if (!sharedChannelId) {
      return;
    }

    // Update slack channel in database
    await saveSharedSlackChannel(db, connectionDetails, sharedChannelId);

    // Invite the user to the channel
    await inviteUserToSharedChannel(env, sharedChannelId, email);

    // Commenting this out for now so I can personally outreach to each channel
    // // Step 4: Send a message to the channel with a welcome message
    // await fetch('https://slack.com/api/chat.postMessage', {
    //   method: 'POST',
    //   headers: headers,
    //   body: JSON.stringify({
    //     channel: createChannelResponseData.channel.id,
    //     text: `Welcome to your direct support channel! Let us know if you have any questions or feedback as you're getting set up.`
    //   })
    // });
  } catch (error) {
    safeLog('error', 'Error in setupSupportChannelInSlack:', error);
    throw error;
  }
}

async function setupCustomerInStripe(
  requestJson: any,
  connectionDetails: SlackConnection,
  db: ReturnType<typeof initializeDb>,
  email: string,
  env: Env
) {
  // Check if a subscription already exists for this connection
  if (connectionDetails.subscriptionId) {
    return;
  }

  // Get idempotency key from request
  const idempotencyKey = requestJson.idempotencyKey;
  if (!idempotencyKey) {
    safeLog('error', 'No idempotency key found');
    return;
  }

  try {
    // Create customer in Stripe
    const stripeAccount = await createStripeAccount(
      connectionDetails.name,
      email,
      env,
      idempotencyKey
    );

    const databaseSubscription = await createSubscription(
      db,
      env,
      stripeAccount.subscriptionId,
      stripeAccount.currentPeriodStart,
      stripeAccount.currentPeriodEnd
    );

    // If that failed for some reason throw an error, it's safe to retry
    if (!databaseSubscription || databaseSubscription.length === 0) {
      safeLog('error', 'Error upserting subscription');
      throw new Error('Error upserting subscription');
    }

    await attachSubscriptionToSlackConnection(
      db,
      connectionDetails.id,
      databaseSubscription[0].id,
      stripeAccount.customerId
    );
  } catch (error) {
    safeLog('error', 'Error in setupCustomerInStripe:', error);
    throw error;
  }
}
