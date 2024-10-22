import { ZendeskResponse } from '@/interfaces/zendesk-api.interface';
import { SlackMessageData } from '@/interfaces/slack-api.interface';
import {
  slackMarkdownToHtml,
  generateHTMLPermalink
} from './message-formatters';
import { safeLog } from './logging';
import {
  SlackConnection,
  ZendeskConnection,
  Channel,
  Conversation
} from './schema-sqlite';
import { getParentMessageId, needsFollowUpTicket } from './utils';
import { GlobalSettings } from '@/interfaces/global-settings.interface';
import { getSlackUser } from './slack-api';
import {
  createConversation,
  getZendeskCredentials,
  updateLatestSlackMessageId
} from './database';
import { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '@/lib/schema-sqlite';
import { Env } from '@/interfaces/env.interface';

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
  return triggerResponseJson.trigger.id?.toString() ?? null;
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
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(commentData)
    }
  );
}

export async function createFollowUpTicket(
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  key: CryptoKey,
  slackConnectionInfo: SlackConnection,
  messageData: SlackMessageData,
  fileUploadTokens: string[] | undefined,
  followUpTicketId?: string | undefined,
  channelInfo?: Channel,
  zendeskCredentials?: ZendeskConnection | undefined,
  zendeskUserId?: number | undefined
): Promise<{ ticketId: string | null }> {
  if (!channelInfo) {
    safeLog('warn', 'No channel info provided for follow-up ticket');
    return { ticketId: null };
  }
  return await createNewTicket(
    db,
    env,
    key,
    slackConnectionInfo,
    messageData,
    channelInfo,
    fileUploadTokens,
    followUpTicketId,
    zendeskCredentials,
    zendeskUserId
  );
}

export async function createNewTicket(
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  key: CryptoKey,
  slackConnectionInfo: SlackConnection,
  messageData: SlackMessageData,
  channelInfo: Channel,
  fileUploadTokens: string[] | undefined,
  followUpTicketId?: string | undefined,
  zendeskCredentials?: ZendeskConnection | undefined,
  zendeskUserId?: number | undefined
): Promise<{ ticketId: string | null }> {
  // Fetch Zendesk credentials if not provided
  if (!zendeskCredentials) {
    try {
      zendeskCredentials = await getZendeskCredentials(
        db,
        env,
        slackConnectionInfo.id,
        key
      );
    } catch (error) {
      safeLog('error', error);
      throw new Error('Error fetching Zendesk credentials');
    }
    if (!zendeskCredentials) {
      safeLog(
        'log',
        `No Zendesk credentials found for slack connection: ${slackConnectionInfo.id}`
      );
      return;
    }
  }

  // Get or create Zendesk user if not provided
  if (!zendeskUserId) {
    try {
      zendeskUserId = await getOrCreateZendeskUser(
        slackConnectionInfo,
        zendeskCredentials,
        messageData
      );
    } catch (error) {
      safeLog('error', `Error getting or creating Zendesk user:`, error);
      throw error;
    }
    if (!zendeskUserId) {
      safeLog('error', 'No Zendesk user ID');
      throw new Error('No Zendesk user ID');
    }
  }

  // Create Zendesk ticket indepotently using Slack message ID + channel ID?
  const idempotencyKey = channelInfo.slackChannelIdentifier + messageData.ts;
  const zendeskAuthToken = btoa(
    `${zendeskCredentials.zendeskEmail}/token:${zendeskCredentials.zendeskApiKey}`
  );

  // Set the primary key for the conversation
  const externalId = `zensync-${crypto.randomUUID()}`;

  let htmlBody = slackMarkdownToHtml(messageData.text);
  if (!htmlBody || htmlBody === '') {
    htmlBody = '<i>(Empty message)</i>';
  }

  const globalSettings: GlobalSettings =
    slackConnectionInfo.globalSettings || {};

  let channelTags = channelInfo.tags || globalSettings.defaultZendeskTags || [];
  channelTags.push('zensync');
  const assignee =
    channelInfo.defaultAssigneeEmail || globalSettings.defaultZendeskAssignee;

  // Create a ticket in Zendesk
  let ticketData: any = {
    ticket: {
      subject: `${channelInfo?.name}: ${
        messageData.text?.substring(0, 69) ?? ''
      }...`,
      comment: {
        html_body:
          htmlBody + generateHTMLPermalink(slackConnectionInfo, messageData),
        public: true,
        author_id: zendeskUserId
      },
      requester_id: zendeskUserId,
      external_id: externalId,
      tags: channelTags,
      ...(assignee && {
        assignee_email: assignee
      }),
      ...(followUpTicketId && {
        via_followup_source_id: followUpTicketId
      })
    }
  };

  if (fileUploadTokens && fileUploadTokens.length > 0) {
    ticketData.ticket.comment.uploads = fileUploadTokens;
  }

  try {
    const response = await fetch(
      `https://${zendeskCredentials.zendeskDomain}.zendesk.com/api/v2/tickets.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${zendeskAuthToken}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey
        },
        body: JSON.stringify(ticketData)
      }
    );

    const responseData = (await response.json()) as ZendeskResponse;

    if (!response.ok) {
      throw new Error(`Error creating ticket ${JSON.stringify(responseData)}`);
    }

    // Convert the ticket ID to a string and log an error if not possible
    let ticketId = responseData.ticket.id;
    if (typeof responseData.ticket.id === 'number') {
      ticketId = responseData.ticket.id.toString();
    } else {
      safeLog('error', 'Invalid ticket ID:', responseData.ticket.id);
    }

    await createConversation(
      db,
      externalId,
      channelInfo.id,
      getParentMessageId(messageData) ?? messageData.ts,
      ticketId,
      messageData.user,
      followUpTicketId
    );

    return { ticketId: ticketId };
  } catch (error) {
    safeLog('error', 'Error creating Zendesk ticket:', error);
    return { ticketId: null };
  }
}

export async function addTicketComment(
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  key: CryptoKey,
  slackConnectionInfo: SlackConnection,
  conversationInfo: Conversation,
  channelInfo: Channel,
  messageData: SlackMessageData,
  isPublic: boolean,
  status: string,
  fileUploadTokens: string[] | undefined,
  zendeskCredentials?: ZendeskConnection | undefined,
  zendeskUserId?: number | undefined
): Promise<{ ticketId: string | null }> {
  if (!messageData.channel || !messageData.ts) {
    safeLog('error', `Message should not be sent to ticket reply`, messageData);
    return;
  }

  // Fetch Zendesk credentials if not provided
  if (!zendeskCredentials) {
    try {
      zendeskCredentials = await getZendeskCredentials(
        db,
        env,
        slackConnectionInfo.id,
        key
      );
    } catch (error) {
      safeLog('error', error);
      throw new Error('Error fetching Zendesk credentials');
    }
    if (!zendeskCredentials) {
      safeLog(
        'log',
        `No Zendesk credentials found for slack connection: ${slackConnectionInfo.id}`
      );
      return;
    }
  }

  // Get or create Zendesk user if not provided
  if (!zendeskUserId) {
    try {
      zendeskUserId = await getOrCreateZendeskUser(
        slackConnectionInfo,
        zendeskCredentials,
        messageData
      );
    } catch (error) {
      safeLog('error', `Error getting or creating Zendesk user:`, error);
      throw error;
    }
    if (!zendeskUserId) {
      safeLog('error', 'No Zendesk user ID');
      throw new Error('No Zendesk user ID');
    }
  }

  if (!conversationInfo || !conversationInfo.zendeskTicketId) {
    safeLog('error', 'No conversation found for message:', messageData);
    throw new Error('No conversation found');
  }

  try {
    const zendeskAuthToken = btoa(
      `${zendeskCredentials.zendeskEmail}/token:${zendeskCredentials.zendeskApiKey}`
    );

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
          author_id: zendeskUserId
        },
        status: status
      }
    };

    if (fileUploadTokens && fileUploadTokens.length > 0) {
      commentData.ticket.comment.uploads = fileUploadTokens;
    }

    const response = await fetch(
      `https://${zendeskCredentials.zendeskDomain}.zendesk.com/api/v2/tickets/${conversationInfo.zendeskTicketId}.json`,
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

    const responseJson = (await response.json()) as ZendeskResponse;

    if (isPublic && needsFollowUpTicket(responseJson)) {
      safeLog('log', 'Creating follow-up ticket');
      return await createFollowUpTicket(
        db,
        env,
        key,
        slackConnectionInfo,
        messageData,
        fileUploadTokens,
        conversationInfo.zendeskTicketId,
        channelInfo,
        zendeskCredentials,
        zendeskUserId
      );
    } else if (!response.ok) {
      safeLog('error', 'Error creating comment:', responseJson);
      throw new Error('Error creating comment');
    } else if (conversationInfo.latestSlackMessageId !== messageData.ts) {
      await updateLatestSlackMessageId(db, conversationInfo.id, messageData.ts);
    }
  } catch (error) {
    safeLog('error', 'Error adding comment to Zendesk ticket:', error);
    throw error;
  }
}

export async function getOrCreateZendeskUser(
  slackConnection: SlackConnection,
  zendeskCredentials: ZendeskConnection,
  messageData: SlackMessageData
): Promise<number | undefined> {
  const zendeskAuthToken = btoa(
    `${zendeskCredentials.zendeskEmail}/token:${zendeskCredentials.zendeskApiKey}`
  );

  const slackChannelId = messageData.channel;

  if (!messageData.user) {
    safeLog('error', `No slack user found:`, messageData);
    throw new Error('No message user found');
  }

  try {
    const { username, imageUrl } = await getSlackUser(
      slackConnection,
      messageData.user
    );

    const zendeskUserData = {
      user: {
        name: `${username} (via Slack)` || 'Unknown Slack user',
        skip_verify_email: true,
        external_id: `zensync-:${messageData.user}`,
        remote_photo_url: imageUrl
      }
    };

    const response = await fetch(
      `https://${zendeskCredentials.zendeskDomain}.zendesk.com/api/v2/users/create_or_update`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${zendeskAuthToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(zendeskUserData)
      }
    );

    if (!response.ok) {
      throw new Error('Error updating or creating user');
    }

    const responseData = (await response.json()) as ZendeskResponse;

    return responseData.user.id;
  } catch (error) {
    safeLog('error', `Error creating or updating user:`, error);
    throw error;
  }
}
