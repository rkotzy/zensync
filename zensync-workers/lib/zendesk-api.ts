import { ZendeskResponse } from '@/interfaces/zendesk-api.interface';
import { SlackMessageData } from '@/interfaces/slack-api.interface';
import {
  slackMarkdownToHtml,
  generateHTMLPermalink
} from './message-formatters';
import { safeLog } from './logging';
import { SlackConnection, ZendeskConnection } from './schema-sqlite';

export async function createZendeskTrigger(
  zendeskAuthToken: string,
  zendeskDomain: string,
  zendeskWebhookId: string
): Promise<string | null> {
  // Create a zendesk trigger to alert the webhook of ticket changes
  const triggerPayload = JSON.stringify({
    trigger: {
      title: 'Zensync - Slack-to-Zendesk Sync [DO NOT EDIT]',
      description:
        'Two-way sync between Slack and Zendesk. Contact your admin or email support@slacktozendesk.com for help.',
      active: true,
      conditions: {
        all: [
          {
            field: 'status',
            operator: 'greater_than',
            value: 'new'
          },
          {
            field: 'role',
            operator: 'is',
            value: 'agent'
          },
          {
            field: 'current_tags',
            operator: 'includes',
            value: 'zensync'
          },
          {
            field: 'comment_is_public',
            operator: 'is',
            value: 'true'
          }
        ]
      },
      actions: [
        {
          field: 'notification_webhook',
          value: [
            zendeskWebhookId,
            '{\n  "ticket_id": "{{ticket.id}}",\n  "external_id": "{{ticket.external_id}}",\n  "last_updated_at": "{{ticket.updated_at_with_timestamp}}",\n  "created_at": "{{ticket.created_at_with_timestamp}}",\n  "requester_email": "{{ticket.requester.email}}",\n  "requester_external_id": "{{ticket.requester.external_id}}",\n  "current_user_email": "{{current_user.email}}",\n  "current_user_name": "{{current_user.name}}",\n  "current_user_external_id": "{{current_user.external_id}}",\n  "current_user_signature": "{{current_user.signature}}",\n "message": "{{ticket.latest_public_comment}}",\n  "is_public": "{{ticket.latest_public_comment.is_public}}",\n  "attachments": [\n    {% for attachment in ticket.latest_public_comment.attachments %}\n    {\n      "filename": "{{attachment.filename}}",\n      "url": "{{attachment.url}}"\n    }{% if forloop.last == false %},{% endif %}\n    {% endfor %}\n  ],\n  "via": "{{ticket.via}}"\n}\n'
          ]
        }
      ]
    }
  });

  const zendeskTriggerResponse = await fetch(
    `https://${zendeskDomain}.zendesk.com/api/v2/triggers`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${zendeskAuthToken}`
      },
      body: triggerPayload
    }
  );

  if (!zendeskTriggerResponse.ok) {
    // If the response status is not OK, log the status and the response text
    safeLog(
      'error',
      `Zendesk Trigger API failed with status: ${zendeskTriggerResponse.status}`
    );
    safeLog('error', `Response: ${await zendeskTriggerResponse.text()}`);
    throw new Error('Failed to set Zendesk trigger');
  }

  // Parse the response body to JSON
  const triggerResponseJson =
    (await zendeskTriggerResponse.json()) as ZendeskResponse;
  return triggerResponseJson.trigger.id ?? null;
}

export async function getWebhookSigningSecret(
  zendeskAuthToken: string,
  zendeskDomain: string,
  zendeskWebhookId: string
): Promise<string> {
  const zendeskWebhookSecretResponse = await fetch(
    `https://${zendeskDomain}.zendesk.com/api/v2/webhooks/${zendeskWebhookId}/signing_secret`,
    {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${zendeskAuthToken}`
      }
    }
  );

  if (!zendeskWebhookSecretResponse.ok) {
    // If the response status is not OK, log the status and the response text
    safeLog(
      'error',
      `Zendesk webhook signing secret API failed with status: ${zendeskWebhookSecretResponse.status}`
    );
    safeLog('error', `Response: ${await zendeskWebhookSecretResponse.text()}`);
    throw new Error('Failed to get Zendesk webhook signing secret');
  }

  // Parse the response body to JSON
  const signingSecretResponseJson =
    (await zendeskWebhookSecretResponse.json()) as ZendeskResponse;
  return signingSecretResponseJson.signing_secret?.secret ?? null;
}

export async function getLatestTicketByExternalId(
  zendeskAuthToken: string,
  zendeskDomain: string,
  externalId: string
): Promise<{ ticketId: string; status: string }> {
  const zendeskTicketResponse = await fetch(
    `https://${zendeskDomain}.zendesk.com/api/v2/tickets?external_id=${externalId}&sort_by=created_at&sort_order=desc&page[1]`,
    {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${zendeskAuthToken}`
      }
    }
  );

  if (!zendeskTicketResponse.ok) {
    // If the response status is not OK, log the status and the response text
    safeLog(
      'error',
      `Zendesk ticked lookup failed with status: ${zendeskTicketResponse.status}`
    );
    safeLog('error', `Response: ${await zendeskTicketResponse.text()}`);
    throw new Error('Failed to get Zendesk ticket');
  }

  // Parse the response body to JSON
  const responseJson = (await zendeskTicketResponse.json()) as ZendeskResponse;
  const tickets = responseJson.tickets;
  if (!tickets || tickets.length === 0) {
    throw new Error(
      `No tickets found in ${zendeskDomain} for ID ${externalId}`
    );
  }

  return {
    ticketId: tickets[0].id,
    status: tickets[0].status
  };
}

export async function postTicketComment(
  zendeskAuthToken: string,
  zendeskDomain: string,
  slackConnectionInfo: SlackConnection,
  zendeskTicketId: string,
  messageData: SlackMessageData,
  isPublic: boolean,
  authorId: number,
  status: string,
  fileUploadTokens: string[] | undefined
): Promise<any> {
  // Create ticket comment indepotently using Slack message ID + channel ID?
  const idempotencyKey = messageData.channel + messageData.ts;

  let htmlBody = slackMarkdownToHtml(messageData.text);
  if (!htmlBody || htmlBody === '') {
    htmlBody = '<i>(Empty message)</i>';
  }

  // Create a comment in ticket
  let commentData: any = {
    ticket: {
      comment: {
        html_body:
          htmlBody + generateHTMLPermalink(slackConnectionInfo, messageData),
        public: isPublic,
        author_id: authorId
      },
      status: status
    }
  };

  if (fileUploadTokens && fileUploadTokens.length > 0) {
    commentData.ticket.comment.uploads = fileUploadTokens;
  }

  const response = await fetch(
    `https://${zendeskDomain}.zendesk.com/api/v2/tickets/${zendeskTicketId}.json`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Basic ${zendeskAuthToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify(commentData)
    }
  );

  return response;
}

export async function postSlackWarningMessage(
  zendeskCredentials: ZendeskConnection,
  zendeskTicketId: string,
  idempotencyKey: string,
  message: string
): Promise<void> {
  const zendeskAuthToken = btoa(
    `${zendeskCredentials.zendeskEmail}/token:${zendeskCredentials.zendeskApiKey}`
  );

  // Create a comment in ticket
  let commentData: any = {
    ticket: {
      comment: {
        html_body: `<p><strong>Your message was not delivered!</strong></p><p>${message}</p>`,
        public: false
      },
      status: 'open'
    }
  };

  const response = await fetch(
    `https://${zendeskCredentials.zendeskDomain}.zendesk.com/api/v2/tickets/${zendeskTicketId}.json`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Basic ${zendeskAuthToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify(commentData)
    }
  );
}
