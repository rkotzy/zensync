import { ZendeskEvent } from '@/interfaces/zendesk-api.interface';
import { Env } from '@/interfaces/env.interface';
import { isSubscriptionActive, singleEventAnalyticsLogger } from '@/lib/utils';
import { safeLog } from '@/lib/logging';
import { RequestInterface } from '@/interfaces/request.interface';
import { getConversationFromPublicId } from '@/lib/database';
import { sendSlackMessage } from '@/lib/slack-api';

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
    
    try {
      // Get the conversation from external_id on the event
      const conversationInfo = await getConversationFromPublicId(
        db,
        requestBody.external_id
      );

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

      // Send the message into Slack
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