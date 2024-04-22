import {
  SlackConnection,
  ZendeskConnection,
  Conversation,
  Channel
} from '@/lib/schema-sqlite';
import { FollowUpTicket } from '@/interfaces/follow-up-ticket.interface';
import {
  SlackMessageData,
  SlackResponse
} from '@/interfaces/slack-api.interface';
import {
  isSubscriptionActive,
  isChannelEligibleForMessaging
} from '@/lib/utils';
import {
  getZendeskCredentials,
  updateChannelActivity,
  getChannel,
  getChannels,
  createOrUpdateChannel,
  updateChannelMembership,
  updateChannelName,
  updateChannelIdentifier,
  getConversation,
  updateConversationLatestMessage,
  createConversation,
  getLatestConversation
} from '@/lib/database';
import { Env } from '@/interfaces/env.interface';
import { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '@/lib/schema-sqlite';
import { ZendeskResponse } from '@/interfaces/zendesk-api.interface';
import { importEncryptionKeyFromEnvironment } from '@/lib/encryption';
import { getChannelsByProductId } from '@/interfaces/products.interface';
import Stripe from 'stripe';
import { safeLog } from '@/lib/logging';
import {
  GlobalSettingDefaults,
  GlobalSettings
} from '@/interfaces/global-settings.interface';
import { initializeDb } from '@/lib/database';
import {
  postEphemeralMessage,
  getSlackUser,
  getPreviousSlackMessage
} from '@/lib/slack-api';
import {
  slackMarkdownToHtml,
  generateHTMLPermalink
} from '@/lib/message-formatters';
import { singleEventAnalyticsLogger } from '@/lib/posthog';
import { fetchChannelInfo } from '@/lib/slack-api';

const MISSING_ZENDESK_CREDENTIALS_MESSAGE =
  'Zendesk credentials are missing or inactive. Configure them in the Zensync app settings to start syncing messages.';

const eventHandlers: Record<
  string,
  (
    body: any,
    connection: SlackConnection,
    db: DrizzleD1Database<typeof schema>,
    env: Env,
    key: CryptoKey,
    analyticsIdempotencyKey: string | null
  ) => Promise<void>
> = {
  member_joined_channel: handleChannelJoined,
  channel_left: handleChannelLeft,
  message: handleMessage,
  file_share: handleFileUpload,
  message_changed: handleMessageEdit,
  message_deleted: handleMessageDeleted,
  channel_archive: handleChannelLeft,
  channel_deleted: handleChannelLeft,
  channel_unarchive: handleChannelUnarchive,
  channel_rename: handleChannelNameChanged,
  channel_id_changed: handleChannelIdChanged
  // Add more event handlers as needed
};

export async function handleMessageFromSlack(requestJson: any, env: Env) {
  const requestBody = requestJson.eventBody;
  const connectionDetails = requestJson.connectionDetails;
  const analyticsIdempotencyKey = requestJson.idempotencyKey || null;
  if (!connectionDetails) {
    safeLog('error', 'No connection details found in request:', requestJson);
    return;
  }

  const db = initializeDb(env);
  const encryptionKey = await importEncryptionKeyFromEnvironment(env);

  const eventType = requestBody.event?.type;
  const eventSubtype = requestBody.event?.subtype;

  if (eventSubtype && eventHandlers[eventSubtype]) {
    try {
      await eventHandlers[eventSubtype](
        requestBody,
        connectionDetails,
        db,
        env,
        encryptionKey,
        analyticsIdempotencyKey
      );
    } catch (error) {
      safeLog('error', `Error handling ${eventSubtype} subtype event:`, error);
      throw new Error(`Error handling ${eventSubtype} event`);
    }
  } else if (eventType && eventHandlers[eventType]) {
    try {
      await eventHandlers[eventType](
        requestBody,
        connectionDetails,
        db,
        env,
        encryptionKey,
        analyticsIdempotencyKey
      );
    } catch (error) {
      safeLog('error', `Error handling ${eventType} event:`, error);
      throw new Error(`Error handling ${eventSubtype} event`);
    }
  } else {
    safeLog('log', `No handler for event type: ${eventType}`);
  }
}

async function handleChannelJoined(
  request: any,
  connection: SlackConnection,
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  key: CryptoKey,
  analyticsIdempotencyKey: string | null
) {
  const eventData = request.event;
  const channelId = eventData.channel;

  if (connection.botUserId !== eventData.user) {
    return;
  }

  try {
    let channelStatus: string | null = null;

    // Check channel limit
    const limitedChannels = await getChannels(db, connection.id, 10);

    const channelLimit = getChannelsByProductId(
      connection.subscription?.stripeProductId
    );

    // Leave channel if limit reached, set status to PENDING_UPGRADE
    // The +1 is to account for the channel being joined
    if (
      limitedChannels.length + 1 > channelLimit || // More channels than allowed
      !isSubscriptionActive(connection, env) // Subscription is expired
    ) {
      // Set channel status to PENDING_UPGRADE
      channelStatus = 'PENDING_UPGRADE';

      // Send ephemeral message to channel inviter
      const inviterUserId = eventData.inviter;
      if (inviterUserId && inviterUserId !== '') {
        await postUpgradeEphemeralMessage(
          channelId,
          inviterUserId,
          connection,
          env
        );
      }
    }

    // We haven't exceeded the channel limit, so we can continue

    // Post an ephemeral message if there are no Zendesk credentials
    const zendeskCredentials = await getZendeskCredentials(
      db,
      env,
      connection.id,
      key
    );

    if (!zendeskCredentials || zendeskCredentials.status !== 'ACTIVE') {
      const inviterUserId = eventData.inviter;
      if (inviterUserId && inviterUserId !== '') {
        await postEphemeralMessage(
          channelId,
          inviterUserId,
          MISSING_ZENDESK_CREDENTIALS_MESSAGE,
          connection,
          env
        );
      }
    }

    // Fetch channel info from Slack
    let channelJoinResponseData: SlackResponse;
    try {
      channelJoinResponseData = await fetchChannelInfo(
        channelId,
        connection.token
      );
    } catch (error) {
      throw error;
    }

    const channelType = getChannelType(channelJoinResponseData.channel);
    const channelName = channelJoinResponseData.channel?.name;

    const isShared =
      channelJoinResponseData.channel?.is_ext_shared ||
      channelJoinResponseData.channel?.is_pending_ext_shared;

    // Save or update channel in database
    await createOrUpdateChannel(
      db,
      connection.id,
      channelId,
      channelType,
      channelName,
      isShared,
      channelStatus
    );

    await singleEventAnalyticsLogger(
      eventData.inviter,
      'channel_joined',
      connection.slackTeamId,
      eventData.channel,
      request.event_time,
      analyticsIdempotencyKey,
      null,
      env,
      null
    );
  } catch (error) {
    safeLog('error', 'Error saving channel to database:', error);
    throw error;
  }
}

async function postUpgradeEphemeralMessage(
  channelId: string,
  userId: string,
  connection: SlackConnection,
  env: Env
): Promise<void> {
  // Post a ephemeral message to the user in the channel
  // to inform them that the channel limit has been reached
  let ephemeralMessageText =
    "You've reached your maximum channel limit, upgrade your plan to join this channel.";

  const stripe = new Stripe(env.STRIPE_API_KEY);
  const session: Stripe.BillingPortal.Session =
    await stripe.billingPortal.sessions.create({
      customer: connection.stripeCustomerId,
      return_url: `https://${connection.domain}.slack.com`,
      ...(connection.subscription?.stripeSubscriptionId && {
        flow_data: {
          type: 'subscription_update',
          subscription_update: {
            subscription: connection.subscription.stripeSubscriptionId
          }
        }
      })
    });

  const portalUrl = session.url;
  if (portalUrl) {
    ephemeralMessageText = `You've reached you maximum channel limit, <${portalUrl}|upgrade your plan> to join this channel.`;
  }

  await postEphemeralMessage(
    channelId,
    userId,
    ephemeralMessageText,
    connection,
    env
  );
}

function getChannelType(channelData: any): string | null {
  if (typeof channelData !== 'object' || channelData === null) {
    safeLog('warn', 'Invalid or undefined channel data received:', channelData);
    return null;
  }

  if (channelData.is_channel) {
    return 'PUBLIC';
  } else if (channelData.is_private) {
    return 'PRIVATE';
  } else if (channelData.is_im) {
    return 'DM';
  } else if (channelData.is_mpim) {
    return 'GROUP_DM';
  }

  safeLog('warn', `Unkonwn channel type: ${channelData}`);
  return null;
}

async function handleChannelLeft(
  request: any,
  connection: SlackConnection,
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  key: CryptoKey,
  analyticsIdempotencyKey: string | null
) {
  const eventData = request.event;
  const channelId = eventData.channel;

  try {
    await updateChannelMembership(db, connection.id, channelId, false);

    await singleEventAnalyticsLogger(
      eventData.user,
      'channel_left',
      connection.slackTeamId,
      eventData.channel,
      request.event_time,
      analyticsIdempotencyKey,
      null,
      env,
      null
    );
  } catch (error) {
    safeLog('error', `Error archiving channel in database:`, error);
    throw error;
  }
}

async function handleChannelUnarchive(
  request: any,
  connection: SlackConnection,
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  key: CryptoKey,
  analyticsIdempotencyKey: string | null
) {
  const eventData = request.event;
  const channelId = eventData.channel;

  // TODO: - Roll this into the channel joined handler to send the ephemeral message
  // and check plan limits, etc.

  try {
    await updateChannelMembership(db, connection.id, channelId, true);

    await singleEventAnalyticsLogger(
      eventData.user,
      'channel_joined',
      connection.slackTeamId,
      request.event?.channel,
      request.event_time,
      analyticsIdempotencyKey,
      null,
      env,
      null
    );
  } catch (error) {
    safeLog('error', `Error unarchiving channel in database:`, error);
    throw error;
  }
}

async function handleChannelNameChanged(
  request: any,
  connection: SlackConnection,
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  key: CryptoKey
) {
  const eventData = request.event;

  try {
    await updateChannelName(
      db,
      connection.id,
      eventData.channel.id,
      eventData.channel.name
    );
  } catch (error) {
    safeLog('error', `Error updating channel name in database:`, error);
    throw error;
  }
}

async function handleChannelIdChanged(
  request: any,
  connection: SlackConnection,
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  key: CryptoKey
) {
  const eventData = request.event;

  try {
    await updateChannelIdentifier(
      db,
      connection.id,
      eventData.old_channel_id,
      eventData.new_channel_id
    );
  } catch (error) {
    safeLog('error', `Error updating channel Id in database`, error);
    throw error;
  }
}

async function handleFileUpload(
  request: any,
  connection: SlackConnection,
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  key: CryptoKey,
  analyticsIdempotencyKey: string | null
) {
  if (request.zendeskFileTokens) {
    return await handleMessage(
      request,
      connection,
      db,
      env,
      key,
      analyticsIdempotencyKey
    );
  } else {
    safeLog('log', 'Need to handle file fallback');

    const files = request.event.files;

    // Check if there are files
    if (!files || files.length === 0) {
      safeLog('warn', 'No files found in fallback');
      return await handleMessage(
        request,
        connection,
        db,
        env,
        key,
        analyticsIdempotencyKey
      );
    }

    // Start building the HTML output
    let htmlOutput = '<p><strong>Attachments:</strong>';

    // Iterate over each file and add a link to the HTML output
    for (const file of files) {
      htmlOutput += `<br><a href="${file.permalink}">${file.title}</a>`;
    }

    // Close the paragraph tag
    htmlOutput += '</p>';

    request.event.text += htmlOutput;
    return await handleMessage(
      request,
      connection,
      db,
      env,
      key,
      analyticsIdempotencyKey
    );
  }
}

async function handleMessageEdit(
  request: any,
  connection: SlackConnection,
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  key: CryptoKey,
  analyticsIdempotencyKey: string | null
) {
  // TODO: - I can do this check in the event handler to avoid a worker call
  if (request.event?.message?.text === request.event?.previous_message?.text) {
    safeLog('log', 'Message edit was not a change to text, ignoring');
    return;
  } else if (request.event?.message) {
    // Merge the message data into the event object
    request.event = {
      ...request.event,
      ...request.event.message,
      text: `<strong>(Edited)</strong>\n\n${request.event.message.text}`
    };

    try {
      await singleEventAnalyticsLogger(
        request.event?.user,
        'message_edited',
        connection.slackTeamId,
        request.event?.channel,
        request.event_time,
        analyticsIdempotencyKey,
        null,
        env,
        null
      );
    } catch (error) {
      safeLog('error', `Analytics logging error:`, error);
    }

    // Since files can't be added/removed in an edit, we can just use the message handler
    return await handleMessage(
      request,
      connection,
      db,
      env,
      key,
      analyticsIdempotencyKey
    );
  } else {
    safeLog('warn', `Unhandled message edit type:`, request);
    return;
  }
}

async function handleMessageDeleted(
  request: any,
  connection: SlackConnection,
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  key: CryptoKey,
  analyticsIdempotencyKey: string | null
) {
  if (request.event?.previous_message) {
    // Merge the message data into the event object
    request.event = {
      ...request.event,
      ...request.event.previous_message,
      text: `<strong>(Deleted)</strong>\n\n${request.event.previous_message.text}`
    };

    // If the parent message was deleted, close the ticket
    let status = 'open';
    if (!getParentMessageId(request.event as SlackMessageData)) {
      status = 'closed';
    }

    try {
      await singleEventAnalyticsLogger(
        request.event?.user,
        'message_deleted',
        connection.slackTeamId,
        request.event?.channel,
        request.event_time,
        analyticsIdempotencyKey,
        null,
        env,
        null
      );
    } catch (error) {
      safeLog('error', `Analytics logging error:`, error);
    }

    return await handleMessage(
      request,
      connection,
      db,
      env,
      key,
      analyticsIdempotencyKey,
      false,
      status
    );
  } else {
    safeLog('warn', `Unhandled message deletion:`, request);
    return;
  }
}

async function handleMessage(
  request: any,
  connection: SlackConnection,
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  key: CryptoKey,
  analyticsIdempotencyKey: string | null,
  isPublic: boolean = true,
  status: string = 'open'
) {
  // We should only have this code in one place but might want
  // To introduce it here too
  // if (!isPayloadEligibleForTicket(request, connection)) {
  //   return;
  // }

  // Build the message data interface
  const messageData = request.event as SlackMessageData;
  if (!messageData || messageData.type !== 'message') {
    safeLog('error', 'Invalid message payload', request);
    return;
  }

  // Set any file upload data
  const fileUploadTokens: string[] | undefined = request.zendeskFileTokens;

  // Fetch Zendesk credentials
  let zendeskCredentials: ZendeskConnection | null;
  try {
    zendeskCredentials = await getZendeskCredentials(
      db,
      env,
      connection.id,
      key
    );
  } catch (error) {
    safeLog('error', error);
    throw new Error('Error fetching Zendesk credentials');
  }
  if (!zendeskCredentials) {
    safeLog(
      'log',
      `No Zendesk credentials found for slack connection: ${connection.id}`
    );
    return;
  }

  // Get or create Zendesk user
  let zendeskUserId: number | undefined;
  try {
    zendeskUserId = await getOrCreateZendeskUser(
      connection,
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

  // Check if message is already part of a thread
  const parentMessageId = getParentMessageId(messageData);
  if (parentMessageId || !isPublic) {
    // Handle child message or private message
    try {
      await handleThreadReply(
        messageData,
        zendeskCredentials,
        connection,
        db,
        env,
        parentMessageId ?? messageData.ts,
        zendeskUserId,
        fileUploadTokens,
        isPublic,
        status,
        analyticsIdempotencyKey
      );
    } catch (error) {
      safeLog('error', `Error handling thread reply:`, error);
      throw error;
    }
    return;
  }

  // See if "same-sender timeframe" applies
  const existingConversation = await sameSenderInTimeframeConversation(
    connection,
    messageData,
    db
  );
  if (existingConversation) {
    // Send message to existing Zendesk ticket
    try {
      await sendTicketReplyOrFallbackToNewTicket(
        existingConversation.zendeskTicketId,
        existingConversation.publicId,
        messageData,
        zendeskCredentials,
        connection,
        db,
        env,
        zendeskUserId,
        fileUploadTokens,
        isPublic,
        true,
        status,
        analyticsIdempotencyKey
      );

      await singleEventAnalyticsLogger(
        messageData.user,
        'message_reply',
        connection.slackTeamId,
        messageData.channel,
        messageData.ts,
        analyticsIdempotencyKey,
        {
          is_public: isPublic,
          has_attachments: fileUploadTokens && fileUploadTokens.length > 0,
          source: 'slack',
          same_sender_timeframe: true
        },
        env,
        null
      );
    } catch (error) {
      safeLog('error', `Error handling same sender reply:`, error);
      throw error;
    }
    return;
  }

  // Create zendesk ticket + conversation
  try {
    await handleNewConversation(
      messageData,
      zendeskCredentials,
      connection,
      db,
      env,
      messageData.channel,
      zendeskUserId,
      fileUploadTokens,
      isPublic,
      false,
      analyticsIdempotencyKey
    );
  } catch (error) {
    safeLog('error', `Error creating new conversation:`, error);
    throw error;
  }
}

function getParentMessageId(event: SlackMessageData): string | null {
  if (event.thread_ts && event.thread_ts !== event.ts) {
    return event.thread_ts;
  }

  return null;
}

async function getOrCreateZendeskUser(
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

async function handleThreadReply(
  messageData: SlackMessageData,
  zendeskCredentials: ZendeskConnection,
  slackConnectionInfo: SlackConnection,
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  slackParentMessageId: string,
  authorId: number,
  fileUploadTokens: string[] | undefined,
  isPublic: boolean,
  status: string = 'open',
  analyticsIdempotencyKey: string | null
) {
  // get conversation from database
  const conversationInfo = await getConversation(
    db,
    slackConnectionInfo.id,
    messageData.channel,
    slackParentMessageId
  );

  // If no conversation found, create new ticket
  if (!conversationInfo) {
    safeLog('log', 'No conversation found, creating new ticket');
    return await handleNewConversation(
      messageData,
      zendeskCredentials,
      slackConnectionInfo,
      db,
      env,
      messageData.channel,
      authorId,
      fileUploadTokens,
      isPublic,
      false,
      analyticsIdempotencyKey
    );
  }

  return await sendTicketReplyOrFallbackToNewTicket(
    conversationInfo.zendeskTicketId,
    conversationInfo.publicId,
    messageData,
    zendeskCredentials,
    slackConnectionInfo,
    db,
    env,
    authorId,
    fileUploadTokens,
    isPublic,
    false,
    status,
    analyticsIdempotencyKey
  );
}

async function sendTicketReplyOrFallbackToNewTicket(
  zendeskTicketId: string,
  conversationPublicId: string,
  messageData: SlackMessageData,
  zendeskCredentials: ZendeskConnection,
  slackConnectionInfo: SlackConnection,
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  authorId: number,
  fileUploadTokens: string[] | undefined,
  isPublic: boolean,
  resetParentMessageId: boolean = false,
  status: string = 'open',
  analyticsIdempotencyKey: string | null
) {
  // Create ticket comment indepotently using Slack message ID + channel ID?
  const idempotencyKey = messageData.channel + messageData.ts;
  const zendeskAuthToken = btoa(
    `${zendeskCredentials.zendeskEmail}/token:${zendeskCredentials.zendeskApiKey}`
  );

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

  const responseData = await response.json();

  if (needsFollowUpTicket(responseData)) {
    // Trying to update a public comment on closed ticket
    if (isPublic) {
      const followUpTicket: FollowUpTicket = {
        sourceTicketId: zendeskTicketId,
        conversationPublicId: conversationPublicId
      };

      return await handleNewConversation(
        messageData,
        zendeskCredentials,
        slackConnectionInfo,
        db,
        env,
        messageData.channel,
        authorId,
        fileUploadTokens,
        true,
        resetParentMessageId,
        analyticsIdempotencyKey,
        followUpTicket
      );
    }
  } else if (!response.ok) {
    throw new Error('Error creating comment');
  } else {
    // Was not a follow-up ticket, and no errors, so update the conversation
    try {
      // Update last message ID conversation
      await updateConversationLatestMessage(
        db,
        conversationPublicId,
        messageData.ts,
        null,
        resetParentMessageId
      );

      // Update the channel activity
      await updateChannelActivity(slackConnectionInfo, messageData.channel, db);

      await singleEventAnalyticsLogger(
        messageData.user,
        'message_reply',
        slackConnectionInfo.slackTeamId,
        messageData.channel,
        messageData.ts,
        analyticsIdempotencyKey,
        {
          is_public: isPublic,
          has_attachments: fileUploadTokens && fileUploadTokens.length > 0,
          source: 'slack'
        },
        env,
        null
      );
    } catch (error) {
      safeLog('error', `Error updating conversation in database:`, error);
      throw new Error('Error updating conversation in database');
    }
  }
}

function needsFollowUpTicket(responseJson: any): boolean {
  if (responseJson.error === 'RecordInvalid' && responseJson.details?.status) {
    // Handles updates on closed tickets
    const statusDetails = responseJson.details.status.find((d: any) =>
      d.description.includes('Status: closed prevents ticket update')
    );
    return !!statusDetails;
  } else if (responseJson.error === 'RecordNotFound') {
    // Handles replies to deleted tickets
    return true;
  }
  return false;
}

async function handleNewConversation(
  messageData: SlackMessageData,
  zendeskCredentials: ZendeskConnection,
  slackConnectionInfo: SlackConnection,
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  channelId: string,
  authorId: number,
  fileUploadTokens: string[] | undefined,
  isPublic: boolean,
  resetParentMessageId: boolean = false,
  analyticsIdempotencyKey: string | null,
  followUpTicket: FollowUpTicket | undefined = undefined
) {
  let channelInfo: Channel | null;
  try {
    // Fetch channel info
    channelInfo = await getChannel(db, slackConnectionInfo.id, channelId);
  } catch (error) {
    safeLog('error', `Error fetching channel info:`, error);
    throw error;
  }

  if (!channelInfo) {
    safeLog('error', `No channel found for ${channelId}`);
    throw new Error(`No channel found`);
  }

  if (!channelInfo.name) {
    safeLog('warn', `No channel name found, continuing: ${channelInfo}`);
  }

  if (!isChannelEligibleForMessaging(channelInfo)) {
    safeLog('log', `Channel is not eligible for messaging: ${channelInfo}`);
    return;
  }

  // Create Zendesk ticket indepotently using Slack message ID + channel ID?
  const idempotencyKey = channelId + messageData.ts;
  const zendeskAuthToken = btoa(
    `${zendeskCredentials.zendeskEmail}/token:${zendeskCredentials.zendeskApiKey}`
  );

  // Set the primary key for the conversation
  let conversationUuid =
    followUpTicket?.conversationPublicId ?? crypto.randomUUID();

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
        public: isPublic,
        author_id: authorId
      },
      requester_id: authorId,
      external_id: conversationUuid,
      tags: channelTags,
      ...(assignee && {
        assignee_email: assignee
      }),
      ...(followUpTicket && {
        via_followup_source_id: followUpTicket.sourceTicketId
      })
    }
  };

  if (fileUploadTokens && fileUploadTokens.length > 0) {
    ticketData.ticket.comment.uploads = fileUploadTokens;
  }

  let ticketId: string | null = null;
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
      throw new Error('Error creating ticket');
    }

    ticketId = responseData.ticket.id;

    await singleEventAnalyticsLogger(
      messageData.user,
      'ticket_created',
      slackConnectionInfo.slackTeamId,
      messageData.channel,
      messageData.ts,
      analyticsIdempotencyKey,
      {
        is_public: isPublic,
        has_attachments: fileUploadTokens && fileUploadTokens.length > 0
      },
      env,
      null
    );
  } catch (error) {
    safeLog('error', 'Error creating ticket: ', error);
    throw error;
  }

  if (!ticketId) {
    safeLog('error', 'No ticket ID in payload');
    throw new Error('No ticket ID');
  }

  // Create or update conversation
  if (followUpTicket) {
    try {
      await updateConversationLatestMessage(
        db,
        conversationUuid,
        messageData.ts,
        ticketId,
        resetParentMessageId
      );
    } catch (error) {
      safeLog('error', `Error updating conversation:`, error);
      safeLog('error', 'Failed payload:', {
        zendeskTicketId: ticketId,
        latestSlackMessageId: messageData.ts
      });
    }
  } else {
    try {
      await createConversation(
        db,
        conversationUuid,
        channelInfo.id,
        messageData.ts,
        ticketId,
        messageData.user
      );
    } catch (error) {
      safeLog('error', `Error creating conversation:`, error);
      safeLog('error', 'Failed payload:', {
        id: conversationUuid,
        channelId: channelInfo.id,
        slackParentMessageId: messageData.ts,
        zendeskTicketId: ticketId,
        slackAuthorUserId: messageData.user,
        latestSlackMessageId: messageData.ts
      });
    }
  }

  // Update the channel activity
  try {
    await updateChannelActivity(slackConnectionInfo, channelId, db);
  } catch (error) {
    safeLog('error', `Error updating channel activity:`, error);
    throw error;
  }
}

async function sameSenderInTimeframeConversation(
  connection: SlackConnection,
  currentMessage: SlackMessageData,
  db: DrizzleD1Database<typeof schema>
): Promise<Conversation | null> {
  try {
    const glabalSettings: GlobalSettings = connection.globalSettings || {};
    const timeframeSeconds =
      glabalSettings.sameSenderTimeframe ||
      GlobalSettingDefaults.sameSenderTimeframe;

    // Avoid extra work if tiimeframe is 0
    if (timeframeSeconds === 0) {
      return null;
    }
    // // get the latest conversation from database
    // const latestConversation = await getLatestConversation(
    //   db,
    //   connection.id,
    //   currentMessage.channel
    // );

    // get the latest conversation from the Slack API
    const latestSlackMessage = await getPreviousSlackMessage(
      connection,
      currentMessage.channel,
      currentMessage.ts
    );

    if (!latestSlackMessage) {
      return null;
    }

    // 1. Check if the latest message is from the current user
    if (latestSlackMessage.user !== currentMessage.user) {
      return null;
    }

    // 2. Check that there are no thread replies yet to the message
    if (latestSlackMessage.reply_count !== 0) {
      return null;
    }

    // 3. Check if the latest message is within the timeframe
    const latestMessageTs = parseFloat(latestSlackMessage.ts);
    const currentMessageTs = parseFloat(currentMessage.ts);
    const timeDiff = currentMessageTs - latestMessageTs;

    if (
      timeframeSeconds !== 0 ||
      (timeDiff >= 0 && timeDiff <= timeframeSeconds)
    ) {
      return latestSlackMessage.ts;
    } else {
      return null;
    }
  } catch (error) {
    safeLog(
      'error',
      `Error checking sameSenderInTimeframe conversation:`,
      error
    );
    return null;
  }
}
