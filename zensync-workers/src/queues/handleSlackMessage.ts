import { SlackConnection } from '@/lib/schema-sqlite';
import {
  SlackMessageData,
  SlackResponse
} from '@/interfaces/slack-api.interface';
import {
  isSubscriptionActive,
  getParentMessageId,
  getChannelType
} from '@/lib/utils';
import {
  initializeDb,
  getZendeskCredentials,
  updateChannelActivity,
  getChannel,
  getChannels,
  createOrUpdateChannel,
  updateChannelMembership,
  updateChannelName,
  updateChannelIdentifier,
  getConversationFromSlackMessage,
  getLatestConversationInChannel
} from '@/lib/database';
import { Env } from '@/interfaces/env.interface';
import { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '@/lib/schema-sqlite';
import { importEncryptionKeyFromEnvironment } from '@/lib/encryption';
import { getChannelsByProductId } from '@/interfaces/products.interface';
import { safeLog } from '@/lib/logging';
import {
  GlobalSettingDefaults,
  GlobalSettings
} from '@/interfaces/global-settings.interface';
import {
  postEphemeralMessage,
  postUpgradeEphemeralMessage,
  fetchChannelInfo
} from '@/lib/slack-api';
import { singleEventAnalyticsLogger } from '@/lib/posthog';
import { addTicketComment, createNewTicket } from '@/lib/zendesk-api';
import { time } from 'console';

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
  channel_id_changed: handleChannelIdChanged,
  thread_broadcast: handleMessage
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

    // If limit reached, set status to PENDING_UPGRADE
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

    // Build the message data interface
    const messageData = request.event as SlackMessageData;
    if (!messageData || messageData.type !== 'message') {
      safeLog('error', 'Invalid message payload', request);
      return;
    }

    // Log the event to analytics
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

    const conversationInfo = await getConversationFromSlackMessage(
      db,
      connection.id,
      messageData.channel,
      getParentMessageId(messageData) ?? messageData.ts
    );

    if (!conversationInfo) {
      safeLog('error', 'Could not find conversation for edited message');
      return;
    }

    // Send a private comment back to the ticket
    await addTicketComment(
      db,
      env,
      key,
      connection,
      conversationInfo.conversation,
      conversationInfo.channel,
      messageData,
      false,
      'open',
      undefined
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

    // Build the message data interface
    const messageData = request.event as SlackMessageData;
    if (!messageData || messageData.type !== 'message') {
      safeLog('error', 'Invalid message payload', request);
      return;
    }

    // If the parent message was deleted, close the ticket
    let status = 'open';
    if (!getParentMessageId(request.event as SlackMessageData)) {
      status = 'closed';
    }

    // Log the event to analytics
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

    console.log({
      connectionId: connection.id,
      channelId: messageData.channel,
      ts: messageData.ts,
      messageData: messageData
    });

    const conversationInfo = await getConversationFromSlackMessage(
      db,
      connection.id,
      messageData.channel,
      getParentMessageId(messageData) ?? messageData.ts
    );

    if (!conversationInfo) {
      safeLog('error', 'Could not find conversation for deleted message');
      return;
    }

    // Send a private comment back to the ticket
    await addTicketComment(
      db,
      env,
      key,
      connection,
      conversationInfo.conversation,
      conversationInfo.channel,
      messageData,
      false,
      status,
      undefined
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
  analyticsIdempotencyKey: string | null
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

  // Check if message is already part of a thread
  let existingConversationInfo;
  const parentMessageId = getParentMessageId(messageData);
  if (parentMessageId) {
    try {
      const conversationInfo = await getConversationFromSlackMessage(
        db,
        connection.id,
        messageData.channel,
        parentMessageId
      );
      existingConversationInfo = conversationInfo;
    } catch (error) {
      safeLog('error', 'Error getting conversation info for message:', error);
      throw error;
    }
  } else {
    // If no existing conversation was set from the parent message, check
    // if same-sender-in-timeframe logic applies
    existingConversationInfo = await sameSenderInTimeframeParentMessageId(
      db,
      connection,
      messageData,
      analyticsIdempotencyKey,
      env
    );
  }

  if (existingConversationInfo) {
    // The conversationInfo was found, so we can try to add a comment
    // to the ticket. Make sure to return after so we don't create a
    // new conversation.
    try {
      await addTicketComment(
        db,
        env,
        key,
        connection,
        existingConversationInfo.conversation,
        existingConversationInfo.channel,
        messageData,
        true,
        'open',
        fileUploadTokens
      );

      // Log the reply to analytics
      await singleEventAnalyticsLogger(
        messageData.user,
        'message_reply',
        connection.slackTeamId,
        messageData.channel,
        messageData.ts,
        analyticsIdempotencyKey,
        {
          is_public: true,
          has_attachments: fileUploadTokens && fileUploadTokens.length > 0,
          source: 'slack'
        },
        env,
        null
      );

      await updateChannelActivity(connection, messageData.channel, db);
      // !!! This is really important to return here so we don't create a new ticket
      return;
    } catch (error) {
      safeLog('error', 'Error adding ticket comment:', error);
      throw error;
    }
  }

  // Create zendesk ticket + conversation
  try {
    const channelInfo = await getChannel(
      db,
      connection.id,
      messageData.channel
    );
    await createNewTicket(
      db,
      env,
      key,
      connection,
      messageData,
      channelInfo,
      fileUploadTokens
    );

    await updateChannelActivity(connection, messageData.channel, db);

    // Log the new message to analytics
    await singleEventAnalyticsLogger(
      messageData.user,
      'message_created',
      connection.slackTeamId,
      messageData.channel,
      messageData.ts,
      analyticsIdempotencyKey,
      {
        is_public: true,
        has_attachments: fileUploadTokens && fileUploadTokens.length > 0,
        source: 'slack'
      },
      env,
      null
    );
  } catch (error) {
    safeLog('error', `Error creating new conversation:`, error);
    throw error;
  }
}

async function sameSenderInTimeframeParentMessageId(
  db: DrizzleD1Database<typeof schema>,
  connection: SlackConnection,
  currentMessage: SlackMessageData,
  analyticsIdempotencyKey: string,
  env: Env
) {
  try {
    const globalSettings: GlobalSettings = connection.globalSettings || {};
    const timeframeSeconds =
      globalSettings.sameSenderTimeframe ||
      GlobalSettingDefaults.sameSenderTimeframe;

    // Avoid extra work if timeframe is 0
    if (timeframeSeconds === 0) {
      return null;
    }

    // get the latest conversation from the Slack API
    const latestConversation = await getLatestConversationInChannel(
      db,
      connection.id,
      currentMessage.channel
    );

    if (!latestConversation) {
      return null;
    }

    // 1. The latest message must be from the current user
    if (
      latestConversation.conversation.slackAuthorUserId !== currentMessage.user
    ) {
      return null;
    }

    // 2. Check that there are no thread replies yet to the message
    if (
      latestConversation.conversation.slackParentMessageId !==
      latestConversation.conversation.latestSlackMessageId
    ) {
      return null;
    }

    // 3. Check if the latest message is within the timeframe
    const latestMessageTs = parseFloat(
      latestConversation.conversation.slackParentMessageId
    );
    const currentMessageTs = parseFloat(currentMessage.ts);
    const timeDiff = currentMessageTs - latestMessageTs;

    if (timeDiff >= 0 && timeDiff < timeframeSeconds) {
      await singleEventAnalyticsLogger(
        currentMessage.user,
        'same_sender_in_timeframe',
        connection.slackTeamId,
        currentMessage.channel,
        currentMessage.ts,
        analyticsIdempotencyKey,
        {
          timeDiff: timeDiff,
          timeframe: timeframeSeconds
        },
        env,
        null
      );

      return latestConversation;
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
