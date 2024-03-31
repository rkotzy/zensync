import { initializeDb } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import { Env } from '@/interfaces/env.interface';
import { SlackConnection, slackConnection, subscription } from '@/lib/schema';
import { SlackResponse } from '@/interfaces/slack-api.interface';
import { createStripeAccount } from '@/lib/utils';
import { safeLog } from '@/lib/logging';

export async function slackConnectionCreated(requestJson: any, env: Env) {
  const connectionDetails: SlackConnection = requestJson.connectionDetails;
  if (!connectionDetails) {
    safeLog('error', 'No connection details found', requestJson);
    return;
  }

  // Get name and email of Slack user
  const email = await getAuthedConnectionUserEmail(connectionDetails);

  // Init the db
  const db = initializeDb(env);

  await setupSupportChannelInSlack(connectionDetails, db, email, env);

  await setupCustomerInStripe(requestJson, connectionDetails, db, email, env);
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
    const headers = {
      'Content-type': 'application/json',
      Accept: 'application/json',
      Authorization: 'Bearer ' + env.INTERNAL_SLACKBOT_ACCESS_TOKEN
    };
    // Step 1: Create Slack channel
    let createChannel = await fetch(
      'https://slack.com/api/conversations.create',
      {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          team_id: 'T06Q45PBVGT', // Zensync team Id
          is_private: false,
          name: `ext-zensync-${connectionDetails.domain}`
        })
      }
    );

    const createChannelResponseData =
      (await createChannel.json()) as SlackResponse;

    if (!createChannelResponseData.ok) {
      throw new Error(
        `Error creating Slack channel: ${createChannelResponseData.error}`
      );
    }
    // Step 2: Invite myself to the channel
    let inviteZensyncAccount = await fetch(
      'https://slack.com/api/conversations.invite',
      {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          channel: createChannelResponseData.channel.id,
          users: 'U06QGUD7F5X' // ryan zensync user id
        })
      }
    );

    const inviteZensyncAccountResponseData =
      (await inviteZensyncAccount.json()) as SlackResponse;

    if (!inviteZensyncAccountResponseData.ok) {
      safeLog(
        'error',
        'Error inviting Zensync Account:',
        inviteZensyncAccountResponseData
      );
      throw new Error(
        `Error inviting Zensync Account: ${inviteZensyncAccountResponseData.error}`
      );
    }

    // Step 3: Update slack channel in database
    await db
      .update(slackConnection)
      .set({
        supportSlackChannelId: createChannelResponseData.channel.id,
        supportSlackChannelName: `ext-zensync-${connectionDetails.domain}`
      })
      .where(eq(slackConnection.id, connectionDetails.id));

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

    // Step 5: Invite the user to the channel
    let inviteExternalUser = await fetch(
      'https://slack.com/api/conversations.inviteShared',
      {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          channel: createChannelResponseData.channel.id,
          emails: email,
          external_limited: false
        })
      }
    );

    const inviteExternalUserResponseData =
      (await inviteExternalUser.json()) as SlackResponse;

    if (!inviteExternalUserResponseData.ok) {
      throw new Error(
        `Error inviting user: ${inviteExternalUserResponseData.error}`
      );
    }
  } catch (error) {
    safeLog('error', 'Error in setupSupportChannelInSlack:', error);
    throw new Error('Error in setupSupportChannelInSlack');
  }
}

async function setupCustomerInStripe(
  requestJson: any,
  connectionDetails: SlackConnection,
  db: ReturnType<typeof initializeDb>,
  email: string,
  env: Env
) {
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
      safeLog('error', 'Error upserting subscription');
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
    safeLog('error', 'Error in slackConnectionCreated:', error);
    throw new Error('Error in slackConnectionCreated');
  }
}

async function getAuthedConnectionUserEmail(
  connection: SlackConnection
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
    safeLog('error', `Error in getSlackUserEmail:`, error);
    throw error;
  }
}
