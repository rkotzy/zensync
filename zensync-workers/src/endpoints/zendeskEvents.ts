import { ZendeskEvent } from '@/interfaces/zendesk-api.interface';
import { Env } from '@/interfaces/env.interface';
import { isSubscriptionActive } from '@/lib/utils';
import { safeLog } from '@/lib/logging';
import { RequestInterface } from '@/interfaces/request.interface';
import { sendSlackMessage } from '@/lib/slack-api';
import { postSlackWarningMessage } from '@/lib/zendesk-api';

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
      // Check if the event has an external_id
      let externalId = requestBody.external_id;
      if (!externalId) {
        safeLog('error', 'No external_id found on the event');
        return new Response('Missing external_id', { status: 404 });
      }

      // Check if the external_id is in the correct format
      if (!externalId.startsWith('zensync-')) {
        safeLog('error', `Invalid external_id format: ${externalId}`);
        return new Response('Invalid external_id', { status: 400 });
      }

      const trimmedExternalId = externalId.split('-')[1];
      const channelId: string = trimmedExternalId.split(':')[0];
      const parentMessageId: string = trimmedExternalId.split(':')[1];

      if (!channelId || !parentMessageId) {
        safeLog('error', `Invalid external_id format: ${externalId}`);
        return new Response('Invalid external_id', { status: 400 });
      }

      const slackConnectionInfo = request.slackConnection;

      // Make sure the subscription is active
      if (!isSubscriptionActive(slackConnectionInfo, env)) {
        safeLog('log', 'Subscription is not active, ignoring');
        return new Response('Ok', { status: 200 });
      }

      // Send the message into Slack
      const slackMessageResponse = await sendSlackMessage(
        requestBody,
        slackConnectionInfo,
        parentMessageId,
        channelId,
        env
      );

      if (slackMessageResponse) {
        await postSlackWarningMessage(
          request.zendeskConnection,
          requestBody.ticket_id,
          `warning-${channelId + parentMessageId}}`,
          slackMessageResponse
        );
      }
    } catch (error) {
      safeLog('error', error);
      return new Response('Error', { status: 500 });
    }

    return new Response('Ok', { status: 200 });
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
