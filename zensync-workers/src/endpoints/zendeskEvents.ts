import { OpenAPIRoute } from '@cloudflare/itty-router-openapi';
import { initializeDb } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import { zendeskConnection, SlackConnection, conversation } from '@/lib/schema';
import * as schema from '@/lib/schema';
import { SlackResponse } from '@/interfaces/slack-api.interface';
import { ZendeskEvent } from '@/interfaces/zendesk-api.interface';
import { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { Env } from '@/interfaces/env.interface';
import {
  getSlackConnection,
  isSubscriptionActive,
  singleEventAnalyticsLogger
} from '@/lib/utils';
import bcrypt from 'bcryptjs';
import { safeLog } from '@/lib/logging';

export class ZendeskEventHandler extends OpenAPIRoute {
  async handle(
    request: Request,
    env: Env,
    context: any,
    data: Record<string, any>
  ) {
    // Initialize the database
    const db = initializeDb(env);

    const requestBody = (await request.json()) as ZendeskEvent;

    safeLog('log', 'Zendesk event received:', requestBody);

    // Save some database calls if it's a message from Zensync

    // Ignore messages from Zensync
    if (
      typeof requestBody.current_user_external_id === 'string' &&
      requestBody.current_user_external_id.startsWith('zensync')
    ) {
      safeLog('log', 'Message from Zensync, skipping');
      return new Response('Ok', { status: 200 });
    }

    // Make sure we have the last updated ticket time
    const ticketLastUpdatedAt = requestBody.last_updated_at;
    if (!ticketLastUpdatedAt) {
      safeLog('error', 'Missing last_updated_at');
      return new Response('Missing last_updated_at', { status: 400 });
    }

    // // Ignore messages if last_updated_at === created_at
    // // TODO: - This would ignore messages sent in same minute. Can we store a hash / etag instead?
    // if (requestBody.last_updated_at === requestBody.created_at) {
    //   safeLog('log', 'Message is not an update, skipping');
    //   return new Response('Ok', { status: 200 });
    // }

    // Authenticate the request and get slack connection Id
    const slackConnectionId = await authenticateRequest(request, db);
    if (!slackConnectionId) {
      safeLog('warn', 'Unauthorized');
      return new Response('Unauthorized', { status: 401 });
    }

    // Get the conversation from external_id
    const conversationInfo = await db.query.conversation.findFirst({
      where: eq(conversation.id, requestBody.external_id),
      with: {
        channel: true
      }
    });

    if (!conversationInfo?.slackParentMessageId) {
      safeLog(
        'error',
        `No conversation found for id ${requestBody.external_id}`
      );
      return new Response('No conversation found', { status: 404 });
    }

    // To be safe I should double-check the organization_id owns the channel_id
    if (
      !conversationInfo.channel ||
      !conversationInfo.channel.slackChannelIdentifier ||
      conversationInfo.channel.slackConnectionId !== slackConnectionId
    ) {
      safeLog(
        'error',
        `Invalid Ids: ${slackConnectionId} !== ${conversationInfo}`
      );
      return new Response('Invalid Ids', { status: 401 });
    }

    // Get the full slack connection info
    const slackConnectionInfo = await getSlackConnection(
      slackConnectionId,
      db,
      env
    );

    if (!slackConnectionInfo) {
      safeLog('error', `No Slack connection found for id ${slackConnectionId}`);
      return new Response('No Slack connection found', { status: 404 });
    }

    // Make sure the subscription is active
    if (!isSubscriptionActive(slackConnectionInfo, env)) {
      safeLog('log', 'Subscription is not active, ignoring');
      return new Response('Ok', { status: 200 });
    }

    try {
      await sendSlackMessage(
        requestBody,
        slackConnectionInfo,
        conversationInfo.slackParentMessageId,
        conversationInfo.channel.slackChannelIdentifier,
        env
      );
    } catch (error) {
      safeLog('error', error);
      return new Response('Error', { status: 500 });
    }

    return new Response('Ok', { status: 202 });
  }
}

async function getSlackUserByEmail(
  connection: SlackConnection,
  email: string
): Promise<{ userId: string; username: string | undefined; imageUrl: string }> {
  try {
    const response = await fetch(
      `https://slack.com/api/users.lookupByEmail?email=${email}`,
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
      throw new Error(`Error getting Slack user: ${responseData.error}`);
    }

    const userId = responseData.user.id;
    const username =
      responseData.user.profile?.display_name ||
      responseData.user.profile?.real_name ||
      undefined;
    const imageUrl = responseData.user.profile.image_192;
    return { userId, username, imageUrl };
  } catch (error) {
    safeLog('error', `Error in getSlackUserByEmail:`, error);
    throw error;
  }
}

async function authenticateRequest(
  request: Request,
  db: NeonHttpDatabase<typeof schema>
): Promise<string | null> {
  try {
    const authorizationHeader = request.headers.get('authorization');
    const webhookId = request.headers.get('x-zendesk-webhook-id');
    const bearerToken = authorizationHeader?.replace('Bearer ', '');

    if (!bearerToken) {
      safeLog('error', 'Missing bearer token');
      return null;
    }

    const url = new URL(request.url);

    if (!webhookId) {
      safeLog('error', 'Missing webhook id');
      return null;
    }

    const connection = await db.query.zendeskConnection.findFirst({
      where: eq(zendeskConnection.zendeskWebhookId, webhookId)
    });

    if (!connection) {
      safeLog('error', `Invalid webhook Id ${webhookId}`);
      return null;
    }

    const hashedToken = connection.hashedWebhookBearerToken;
    const isValid = await bcrypt.compare(bearerToken, hashedToken);
    if (!isValid) {
      safeLog('error', 'Invalid bearer token');
      return null;
    }

    return connection.slackConnectionId;
  } catch (error) {
    safeLog('error', 'Error in authenticateRequest:', error);
    return null;
  }
}

async function sendSlackMessage(
  requestBody: any,
  connection: SlackConnection,
  parentMessageId: string,
  slackChannelId: string,
  env: Env
) {
  let username: string | undefined;
  let imageUrl: string | undefined;

  let slackUser: {
    userId: string;
    username: string;
    imageUrl: string;
  };
  try {
    if (requestBody.current_user_email) {
      slackUser = await getSlackUserByEmail(
        connection,
        requestBody.current_user_email
      );
      username = slackUser.username || requestBody.current_user_name;
      imageUrl = slackUser.imageUrl;
    }
  } catch (error) {
    safeLog('warn', `Error getting Slack user: ${error}`);
  }

  try {
    const message = requestBody.message;
    const signature = requestBody.current_user_signature;

    const body = JSON.stringify({
      channel: slackChannelId,
      text: stripSignatureFromMessage(message, signature),
      thread_ts: parentMessageId,
      username: username,
      icon_url: imageUrl
    });

    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${connection.token}`
      },
      body: body
    });

    const responseData = (await response.json()) as SlackResponse;

    if (!responseData.ok) {
      throw new Error(`Error posting message: ${responseData.error}`);
    }
  } catch (error) {
    safeLog('error', `Error in sendSlackMessage:`, error);
    throw error;
  }

  await singleEventAnalyticsLogger(
    slackUser.userId,
    'message_reply',
    connection.appId,
    slackChannelId,
    null,
    null,
    {
      source: 'zendesk'
    },
    env,
    null
  );
}

function stripSignatureFromMessage(
  message: string | undefined | null,
  signature: string | undefined | null
): string {
  // Return the original message if it exists, otherwise return an empty string
  if (!message) {
    return '';
  }

  // If there's no signature, or the signature is not at the end, return the original message
  if (!signature || !message.endsWith(signature)) {
    return message;
  }

  // Remove the signature from the end of the message
  return message.slice(0, message.length - signature.length);
}
