import { SlackConnection } from '@/lib/schema-sqlite';
import { SlackResponse } from '@/interfaces/slack-api.interface';
import { ZendeskEvent } from '@/interfaces/zendesk-api.interface';
import { Env } from '@/interfaces/env.interface';
import { isSubscriptionActive, singleEventAnalyticsLogger } from '@/lib/utils';
import { safeLog } from '@/lib/logging';
import { RequestInterface } from '@/interfaces/request.interface';
import { getConversation } from '@/lib/database';

export class ZendeskEventHandler {
  async handle(
    request: RequestInterface,
    env: Env,
    context: any,
    data: Record<string, any>
  ) {
    // Initialize the database
    const db = request.db;

    const requestBody = request.bodyJson as ZendeskEvent;

    safeLog('log', 'Zendesk event received:', requestBody);

    // Save some database calls if it's a message from Zensync

    // Ignore messages from Zensync
    if (isFromZensync(requestBody)) {
      safeLog('log', 'Message from Zensync, skipping');
      return new Response('Ok', { status: 200 });
    }

    // Ignore messages from ticket merges
    if (isFromTicketMerge(requestBody.message)) {
      safeLog('log', 'Message matches ticket merge, skipping');
      return new Response('Ok', { status: 200 });
    }

    // Get the conversation from external_id
    const conversationInfo = await getConversation(db, requestBody.external_id);

    if (!conversationInfo?.slackParentMessageId) {
      safeLog(
        'error',
        `No conversation found for id ${requestBody.external_id}`
      );
      return new Response('No conversation found', { status: 404 });
    }

    // To be safe I should double-check the organization_id owns the channel_id
    const slackConnectionInfo = request.slackConnection;
    if (
      !conversationInfo.channel ||
      !conversationInfo.channel.slackChannelIdentifier ||
      conversationInfo.channel.slackConnectionId !== slackConnectionInfo.id
    ) {
      safeLog(
        'error',
        `Invalid Ids: ${slackConnectionInfo.id} !== ${conversationInfo}`
      );
      return new Response('Invalid Ids', { status: 401 });
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
    const strippedMessage = stripSignatureFromMessage(message, signature);
    const formattedMessage = zendeskToSlackMarkdown(strippedMessage);

    const body = JSON.stringify({
      channel: slackChannelId,
      text: formattedMessage,
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

function isFromZensync(requestBody: any): boolean {
  return (
    (typeof requestBody.current_user_external_id === 'string' &&
      requestBody.current_user_external_id.startsWith('zensync')) ||
    (typeof requestBody.message === 'string' &&
      requestBody.message.endsWith('_(View in Slack)_'))
  );
}

function isFromTicketMerge(input: string | null | undefined): boolean {
  if (!input) {
    return false;
  }
  const pattern = [
    '^Requests\\s*(.+)\\s*were closed and merged into this request.$',
    '|Request\\s*(.+)\\s*was closed and merged into this request.\\s*(.+)$',
    '|This request was closed and merged into request\\s*(.+)$'
  ].join('');

  const regex = new RegExp(pattern, 's');

  return regex.test(input);
}

function zendeskToSlackMarkdown(zendeskMessage: string): string {
  // Replace Zendesk bold (**text**) with Slack bold (*text*)
  let slackMessage = zendeskMessage.replace(/\*\*(.*?)\*\*/g, '*$1*');

  // Other transformations could be added here if necessary

  return slackMessage;
}
