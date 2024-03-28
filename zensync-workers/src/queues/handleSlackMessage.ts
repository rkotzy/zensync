import { initializeDb } from '@/lib/drizzle';
import { eq, and, is } from 'drizzle-orm';
import {
  channel,
  SlackConnection,
  ZendeskConnection,
  conversation
} from '@/lib/schema';
import { FollowUpTicket } from '@/interfaces/follow-up-ticket.interface';
import {
  SlackMessageData,
  SlackResponse
} from '@/interfaces/slack-api.interface';
import {
  fetchZendeskCredentials,
  updateChannelActivity,
  isSubscriptionActive,
  getChannelInfo,
  isChannelEligibleForMessaging,
  singleEventAnalyticsLogger
} from '@/lib/utils';
import { Env } from '@/interfaces/env.interface';
import { EdgeWithExecutionContext } from '@logtail/edge/dist/es6/edgeWithExecutionContext';
import { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as schema from '@/lib/schema';
import { ZendeskResponse } from '@/interfaces/zendesk-api.interface';
import { importEncryptionKeyFromEnvironment } from '@/lib/encryption';
import { getChannelsByProductId } from '@/interfaces/products.interface';
import Stripe from 'stripe';

const eventHandlers: Record<
  string,
  (
    body: any,
    connection: SlackConnection,
    db: NeonHttpDatabase<typeof schema>,
    env: Env,
    key: CryptoKey,
    logger: EdgeWithExecutionContext,
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

export async function handleMessageFromSlack(
  requestJson: any,
  env: Env,
  logger: EdgeWithExecutionContext
) {
  const requestBody = requestJson.eventBody;
  const connectionDetails = requestJson.connectionDetails;
  const analyticsIdempotencyKey = requestJson.idempotencyKey || null;
  if (!connectionDetails) {
    logger.error('No connection details found');
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
        logger,
        analyticsIdempotencyKey
      );
    } catch (error) {
      logger.error(`Error handling ${eventSubtype} subtype event:`, error);
      throw new Error('Error handling event');
    }
  } else if (eventType && eventHandlers[eventType]) {
    try {
      await eventHandlers[eventType](
        requestBody,
        connectionDetails,
        db,
        env,
        encryptionKey,
        logger,
        analyticsIdempotencyKey
      );
    } catch (error) {
      logger.error(`Error handling ${eventType} event:`, error);
      throw new Error('Error handling event');
    }
  } else {
    logger.warn(`No handler for event type: ${eventType}`);
  }
}

async function handleChannelJoined(
  request: any,
  connection: SlackConnection,
  db: NeonHttpDatabase<typeof schema>,
  env: Env,
  key: CryptoKey,
  logger: EdgeWithExecutionContext,
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
    const limitedChannels = await db
      .select({ id: channel.id })
      .from(channel)
      .where(
        and(
          eq(channel.slackConnectionId, connection.id),
          eq(channel.isMember, true)
        )
      )
      .limit(10);

    const channelLimit = getChannelsByProductId(
      connection.subscription?.stripeProductId
    );

    // Leave channel if limit reached, set status to PENDING_UPGRADE
    // The +1 is to account for the channel being joined
    if (
      limitedChannels.length + 1 > channelLimit || // More channels than allowed
      !isSubscriptionActive(connection, logger, env) // Subscription is expired
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
          env,
          logger
        );
      }
    }

    // We haven't exceeded the channel limit, so we can continue

    // Post an ephemeral message if there are no Zendesk credentials
    const zendeskCredentials = await fetchZendeskCredentials(
      connection.id,
      db,
      env,
      logger,
      key
    );

    if (!zendeskCredentials || zendeskCredentials.status !== 'ACTIVE') {
      await postEphemeralMessage(
        channelId,
        eventData.user,
        'Zendesk credentials are missing or inactive. Configure them in the Zensync app settings to start syncing messages.',
        connection,
        env,
        logger
      );
    }

    // Fetch channel info from Slack
    const params = new URLSearchParams();
    params.append('channel', channelId);
    const channelJoinResponse = await fetch(
      `https://slack.com/api/conversations.info?${params.toString()}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Bearer ${connection.token}`
        }
      }
    );

    const channelJoinResponseData =
      (await channelJoinResponse.json()) as SlackResponse;

    if (!channelJoinResponseData.ok) {
      logger.warn(
        `Failed to fetch channel info: ${channelJoinResponse.statusText}`
      );
      throw new Error('Failed to fetch channel info');
    }

    const channelType = getChannelType(channelJoinResponseData.channel, logger);
    const channelName = channelJoinResponseData.channel?.name;

    const isShared =
      channelJoinResponseData.channel?.is_ext_shared ||
      channelJoinResponseData.channel?.is_pending_ext_shared;

    // Save or update channel in database
    await db
      .insert(channel)
      .values({
        slackConnectionId: connection.id,
        slackChannelIdentifier: channelId,
        type: channelType,
        isMember: true,
        name: channelName,
        isShared: isShared,
        status: channelStatus
      })
      .onConflictDoUpdate({
        target: [channel.slackConnectionId, channel.slackChannelIdentifier],
        set: {
          updatedAt: new Date(),
          type: channelType,
          isMember: true,
          name: channelName,
          isShared: isShared,
          status: channelStatus
        }
      });

    await singleEventAnalyticsLogger(
      eventData.inviter,
      'channel_joined',
      connection.appId,
      eventData.channel,
      request.event_time,
      analyticsIdempotencyKey,
      null,
      env,
      null
    );
  } catch (error) {
    logger.error('Error saving channel to database:', error);
    throw error;
  }
}

async function postEphemeralMessage(
  channelId: string,
  userId: string,
  text: string,
  connection: SlackConnection,
  env: Env,
  logger: EdgeWithExecutionContext
): Promise<void> {
  const postEphemeralParams = new URLSearchParams({
    channel: channelId,
    user: userId,
    text: text
  });

  const ephemeralResponse = await fetch(
    `https://slack.com/api/chat.postEphemeral?${postEphemeralParams.toString()}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${connection.token}`
      }
    }
  );

  if (!ephemeralResponse.ok) {
    logger.error(
      `Failed to post ephemeral message: ${ephemeralResponse.statusText}`
    );
    // We don't throw here since it's not critical if message isn't sent
  }
}

async function postUpgradeEphemeralMessage(
  channelId: string,
  userId: string,
  connection: SlackConnection,
  env: Env,
  logger: EdgeWithExecutionContext
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
    env,
    logger
  );
}

function getChannelType(
  channelData: any,
  logger: EdgeWithExecutionContext
): string | null {
  if (typeof channelData !== 'object' || channelData === null) {
    logger.warn('Invalid or undefined channel data received:', channelData);
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

  logger.warn(`Unkonwn channel type: ${channelData}`);
  return null;
}

async function handleChannelLeft(
  request: any,
  connection: SlackConnection,
  db: NeonHttpDatabase<typeof schema>,
  env: Env,
  key: CryptoKey,
  logger: EdgeWithExecutionContext,
  analyticsIdempotencyKey: string | null
) {
  const eventData = request.event;
  const channelId = eventData.channel;

  try {
    await db
      .update(channel)
      .set({
        updatedAt: new Date(),
        isMember: false
      })
      .where(
        and(
          eq(channel.slackConnectionId, connection.id),
          eq(channel.slackChannelIdentifier, channelId)
        )
      );

    await singleEventAnalyticsLogger(
      eventData.user,
      'channel_left',
      connection.appId,
      eventData.channel,
      request.event_time,
      analyticsIdempotencyKey,
      null,
      env,
      null
    );
  } catch (error) {
    logger.error(`Error archiving channel in database: ${error}`);
    throw error;
  }
}

async function handleChannelUnarchive(
  request: any,
  connection: SlackConnection,
  db: NeonHttpDatabase<typeof schema>,
  env: Env,
  key: CryptoKey,
  logger: EdgeWithExecutionContext,
  analyticsIdempotencyKey: string | null
) {
  const eventData = request.event;
  const channelId = eventData.channel;

  // TODO: - Roll this into the channel joined handler to send the ephemeral message
  // and check plan limits, etc.

  try {
    await db
      .update(channel)
      .set({
        updatedAt: new Date(),
        isMember: true
      })
      .where(
        and(
          eq(channel.slackConnectionId, connection.id),
          eq(channel.slackChannelIdentifier, channelId)
        )
      );

    await singleEventAnalyticsLogger(
      eventData.user,
      'channel_joined',
      connection.appId,
      request.event?.channel,
      request.event_time,
      analyticsIdempotencyKey,
      null,
      env,
      null
    );
  } catch (error) {
    logger.error(`Error unarchiving channel in database: ${error}`);
    throw error;
  }
}

async function handleChannelNameChanged(
  request: any,
  connection: SlackConnection,
  db: NeonHttpDatabase<typeof schema>,
  env: Env,
  key: CryptoKey,
  logger: EdgeWithExecutionContext
) {
  const eventData = request.event;

  try {
    await db
      .update(channel)
      .set({
        updatedAt: new Date(),
        name: eventData.channel.name
      })
      .where(
        and(
          eq(channel.slackConnectionId, connection.id),
          eq(channel.slackChannelIdentifier, eventData.channel.id)
        )
      );
  } catch (error) {
    logger.error(`Error updating channel name in database: ${error}`);
    throw error;
  }
}

async function handleChannelIdChanged(
  request: any,
  connection: SlackConnection,
  db: NeonHttpDatabase<typeof schema>,
  env: Env,
  key: CryptoKey,
  logger: EdgeWithExecutionContext
) {
  const eventData = request.event;

  try {
    await db
      .update(channel)
      .set({
        updatedAt: new Date(),
        slackChannelIdentifier: eventData.new_channel_id
      })
      .where(
        and(
          eq(channel.slackConnectionId, connection.id),
          eq(channel.slackChannelIdentifier, eventData.old_channel_id)
        )
      );
  } catch (error) {
    logger.error(`Error updating channel Id in database: ${error}`);
    throw error;
  }
}

async function handleFileUpload(
  request: any,
  connection: SlackConnection,
  db: NeonHttpDatabase<typeof schema>,
  env: Env,
  key: CryptoKey,
  logger: EdgeWithExecutionContext,
  analyticsIdempotencyKey: string | null
) {
  if (request.zendeskFileTokens) {
    return await handleMessage(
      request,
      connection,
      db,
      env,
      key,
      logger,
      analyticsIdempotencyKey
    );
  } else {
    logger.warn('Need to handle file fallback');

    const files = request.event.files;

    // Check if there are files
    if (!files || files.length === 0) {
      logger.warn('No files found in fallback');
      return await handleMessage(
        request,
        connection,
        db,
        env,
        key,
        logger,
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
      logger,
      analyticsIdempotencyKey
    );
  }
}

async function handleMessageEdit(
  request: any,
  connection: SlackConnection,
  db: NeonHttpDatabase<typeof schema>,
  env: Env,
  key: CryptoKey,
  logger: EdgeWithExecutionContext,
  analyticsIdempotencyKey: string | null
) {
  // TODO: - I can do this check in the event handler to avoid a worker call
  if (request.event?.message?.text === request.event?.previous_message?.text) {
    logger.info('Message edit was not a change to text, ignoring');
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
        connection.appId,
        request.event?.channel,
        request.event_time,
        analyticsIdempotencyKey,
        null,
        env,
        null
      );
    } catch (error) {
      logger.error(`Analytics logging error: ${error}`);
    }

    // Since files can't be added/removed in an edit, we can just use the message handler
    return await handleMessage(
      request,
      connection,
      db,
      env,
      key,
      logger,
      analyticsIdempotencyKey
    );
  } else {
    logger.warn(`Unhandled message edit type: ${request}`);
    return;
  }
}

async function handleMessageDeleted(
  request: any,
  connection: SlackConnection,
  db: NeonHttpDatabase<typeof schema>,
  env: Env,
  key: CryptoKey,
  logger: EdgeWithExecutionContext,
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
        connection.appId,
        request.event?.channel,
        request.event_time,
        analyticsIdempotencyKey,
        null,
        env,
        null
      );
    } catch (error) {
      logger.error(`Analytics logging error: ${error}`);
    }

    return await handleMessage(
      request,
      connection,
      db,
      env,
      key,
      logger,
      analyticsIdempotencyKey,
      false,
      status
    );
  } else {
    logger.warn(`Unhandled message deletion: ${request}`);
    return;
  }
}

async function handleMessage(
  request: any,
  connection: SlackConnection,
  db: NeonHttpDatabase<typeof schema>,
  env: Env,
  key: CryptoKey,
  logger: EdgeWithExecutionContext,
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
    logger.error('Invalid message payload');
    return;
  }

  // Set any file upload data
  const fileUploadTokens: string[] | undefined = request.zendeskFileTokens;

  // Fetch Zendesk credentials
  let zendeskCredentials: ZendeskConnection | null;
  try {
    zendeskCredentials = await fetchZendeskCredentials(
      connection.id,
      db,
      env,
      logger,
      key
    );
  } catch (error) {
    logger.error(error);
    throw new Error('Error fetching Zendesk credentials');
  }
  if (!zendeskCredentials) {
    logger.error(
      `No Zendesk credentials found for slack connection: ${connection.id}`
    );
    throw new Error('No Zendesk credentials found');
  }

  // Get or create Zendesk user
  let zendeskUserId: number | undefined;
  try {
    zendeskUserId = await getOrCreateZendeskUser(
      connection,
      zendeskCredentials,
      messageData,
      logger
    );
  } catch (error) {
    logger.error(`Error getting or creating Zendesk user: ${error}`);
    throw error;
  }
  if (!zendeskUserId) {
    logger.error('No Zendesk user ID');
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
        logger,
        env,
        messageData.channel,
        parentMessageId ?? messageData.ts,
        zendeskUserId,
        fileUploadTokens,
        isPublic,
        status,
        analyticsIdempotencyKey
      );
    } catch (error) {
      logger.error(`Error handling thread reply: ${error}`);
      throw error;
    }
    return;
  }

  // See if "same-sender timeframe" applies
  const existingConversationId = await sameSenderConversationId();
  if (existingConversationId) {
    // Add message to existing conversation
    return;
  }

  // Create zendesk ticket + conversation
  try {
    await handleNewConversation(
      messageData,
      zendeskCredentials,
      connection,
      db,
      logger,
      env,
      messageData.channel,
      zendeskUserId,
      fileUploadTokens,
      isPublic,
      analyticsIdempotencyKey
    );
  } catch (error) {
    logger.error(`Error creating new conversation: ${error}`);
    throw error;
  }
}

function getParentMessageId(event: SlackMessageData): string | null {
  if (event.thread_ts && event.thread_ts !== event.ts) {
    return event.thread_ts;
  }

  return null;
}

async function sameSenderConversationId(): Promise<string | null> {
  // Get the most recent conversation for this channel
  // If the sender is the same and within timeframe, return the conversation ID
  // Otherwise, return null
  return null;
}

async function getOrCreateZendeskUser(
  slackConnection: SlackConnection,
  zendeskCredentials: ZendeskConnection,
  messageData: SlackMessageData,
  logger: EdgeWithExecutionContext
): Promise<number | undefined> {
  const zendeskAuthToken = btoa(
    `${zendeskCredentials.zendeskEmail}/token:${zendeskCredentials.zendeskApiKey}`
  );

  const slackChannelId = messageData.channel;

  if (!messageData.user) {
    logger.error(`No slack user found: ${messageData}`);
    throw new Error('No message user found');
  }

  try {
    const { username, imageUrl } = await getSlackUser(
      slackConnection,
      messageData.user,
      logger
    );

    const zendeskUserData = {
      user: {
        name: `${username} (via Slack)` || 'Unknown Slack user',
        skip_verify_email: true,
        external_id: `zensync-${slackChannelId}:${messageData.user}`,
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
    logger.error(`Error creating or updating user: ${error}`);
    throw error;
  }
}

function extractProfileImageUrls(slackImageUrl: string): {
  gravatarUrl: string;
  slackUrl: string | null;
} {
  const [gravatarUrl, slackUrl] = slackImageUrl.split('&d=');
  return {
    gravatarUrl,
    slackUrl: slackUrl ? decodeURIComponent(slackUrl) : null
  };
}

async function getSlackUser(
  connection: SlackConnection,
  userId: string,
  logger: EdgeWithExecutionContext
): Promise<{ username: string | undefined; imageUrl: string }> {
  try {
    const response = await fetch(
      `https://slack.com/api/users.profile.get?user=${userId}`,
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

    const username =
      responseData.profile.display_name ||
      responseData.profile.real_name ||
      undefined;

    const { gravatarUrl, slackUrl } = extractProfileImageUrls(
      responseData.profile.image_72
    );

    const imageUrl = slackUrl || gravatarUrl;
    return { username, imageUrl };
  } catch (error) {
    logger.error(`Error in getSlackUser: ${error}`);
    throw error;
  }
}

async function handleThreadReply(
  messageData: SlackMessageData,
  zendeskCredentials: ZendeskConnection,
  slackConnectionInfo: SlackConnection,
  db: NeonHttpDatabase<typeof schema>,
  logger: EdgeWithExecutionContext,
  env: Env,
  channelId: string,
  slackParentMessageId: string,
  authorId: number,
  fileUploadTokens: string[] | undefined,
  isPublic: boolean,
  status: string = 'open',
  analyticsIdempotencyKey: string | null
) {
  // get conversation from database
  const conversationInfo = await db
    .select({
      id: conversation.id,
      zendeskTicketId: conversation.zendeskTicketId
    })
    .from(conversation)
    .innerJoin(channel, eq(conversation.channelId, channel.id))
    .where(
      and(
        eq(channel.slackChannelIdentifier, channelId),
        eq(conversation.slackParentMessageId, slackParentMessageId),
        eq(channel.slackConnectionId, slackConnectionInfo.id)
      )
    )
    .limit(1);

  // If no conversation found, create new ticket
  if (
    conversationInfo.length === 0 ||
    !conversationInfo[0].zendeskTicketId ||
    !conversationInfo[0].id
  ) {
    logger.error('No conversation found, creating new ticket');
    return await handleNewConversation(
      messageData,
      zendeskCredentials,
      slackConnectionInfo,
      db,
      logger,
      env,
      channelId,
      authorId,
      fileUploadTokens,
      isPublic,
      analyticsIdempotencyKey
    );
  }

  // Create ticket comment indepotently using Slack message ID + channel ID?
  const idempotencyKey = channelId + messageData.ts;
  const zendeskAuthToken = btoa(
    `${zendeskCredentials.zendeskEmail}/token:${zendeskCredentials.zendeskApiKey}`
  );
  const zendeskTicketId = conversationInfo[0].zendeskTicketId;
  const conversationId = conversationInfo[0].id;

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
        conversationId: conversationId
      };

      return await handleNewConversation(
        messageData,
        zendeskCredentials,
        slackConnectionInfo,
        db,
        logger,
        env,
        messageData.channel,
        authorId,
        fileUploadTokens,
        true,
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
      await db
        .update(conversation)
        .set({
          updatedAt: new Date(),
          latestSlackMessageId: messageData.ts
        })
        .where(eq(conversation.id, conversationId));

      // Update the channel activity
      await updateChannelActivity(slackConnectionInfo, channelId, db, logger);

      await singleEventAnalyticsLogger(
        messageData.user,
        'message_reply',
        slackConnectionInfo.appId,
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
      logger.error(`Error updating conversation in database: ${error}`);
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
  db: NeonHttpDatabase<typeof schema>,
  logger: EdgeWithExecutionContext,
  env: Env,
  channelId: string,
  authorId: number,
  fileUploadTokens: string[] | undefined,
  isPublic: boolean,
  analyticsIdempotencyKey: string | null,
  followUpTicket: FollowUpTicket | undefined = undefined
) {
  // Fetch channel info
  const channelInfo = await getChannelInfo(
    channelId,
    slackConnectionInfo.id,
    db,
    logger
  );

  if (!channelInfo) {
    logger.warn(`No channel found: ${channelId}`);
    throw new Error(`No channel found`);
  }

  if (!channelInfo.name) {
    logger.warn(`No channel name found, continuing: ${channelInfo}`);
  }

  if (!isChannelEligibleForMessaging(channelInfo)) {
    logger.warn(`Channel is not eligible for messaging: ${channelInfo}`);
    return;
  }

  // Create Zendesk ticket indepotently using Slack message ID + channel ID?
  const idempotencyKey = channelId + messageData.ts;
  const zendeskAuthToken = btoa(
    `${zendeskCredentials.zendeskEmail}/token:${zendeskCredentials.zendeskApiKey}`
  );

  // Set the primary key for the conversation
  let conversationUuid = followUpTicket?.conversationId ?? crypto.randomUUID();

  let htmlBody = slackMarkdownToHtml(messageData.text);
  if (!htmlBody || htmlBody === '') {
    htmlBody = '<i>(Empty message)</i>';
  }

  const channelTags = channelInfo.tags || [];

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
      tags: ['zensync', ...channelTags],
      ...(channelInfo.defaultAssigneeEmail && {
        assignee_email: channelInfo.defaultAssigneeEmail
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
      slackConnectionInfo.appId,
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
    logger.error(`Error creating ticket: ${error}`);
    throw error;
  }

  if (!ticketId) {
    logger.error('No ticket ID');
    throw new Error('No ticket ID');
  }

  // Create or update conversation
  if (followUpTicket) {
    try {
      await db
        .update(conversation)
        .set({
          updatedAt: new Date(),
          zendeskTicketId: ticketId,
          latestSlackMessageId: messageData.ts
        })
        .where(eq(conversation.id, conversationUuid));
    } catch (error) {
      logger.error(`Error updating conversation: ${error}`);
      logger.error('Failed payload:', {
        zendeskTicketId: ticketId,
        latestSlackMessageId: messageData.ts
      });
    }
  } else {
    try {
      await db.insert(conversation).values({
        id: conversationUuid,
        channelId: channelInfo.id,
        slackParentMessageId: messageData.ts,
        zendeskTicketId: ticketId,
        slackAuthorUserId: messageData.user,
        latestSlackMessageId: messageData.ts
      });
    } catch (error) {
      logger.error(`Error creating conversation: ${error}`);
      logger.error('Failed payload:', {
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
    await updateChannelActivity(slackConnectionInfo, channelId, db, logger);
  } catch (error) {
    logger.error(`Error updating channel activity: ${error}`);
    throw error;
  }
}

function generateHTMLPermalink(
  slackConnection: SlackConnection,
  messageData: SlackMessageData
): string {
  return `<p><i>(<a href="https://${
    slackConnection.domain
  }.slack.com/archives/${messageData.channel}/p${messageData.ts.replace(
    '.',
    ''
  )}?ref=zensync">View in Slack</a>)</i></p>`;
}

function slackMarkdownToHtml(markdown: string): string {
  // Handle block quotes
  markdown = markdown.replace(/^>\s?(.*)/gm, '<blockquote>$1</blockquote>');

  // Handle code blocks first to prevent formatting inside them
  markdown = markdown.replace(
    /```(.*?)```/gs,
    (_, code) => `<pre><code>${escapeCurlyBraces(code)}</code></pre>`
  );

  // Handle ordered lists
  markdown = markdown.replace(
    /^\d+\.\s(.*)/gm,
    (_, item) => `<li>${item}</li>`
  );
  markdown = markdown.replace(/(<li>.*<\/li>)/gs, '<ol>$1</ol>');

  // Handle bulleted lists
  markdown = markdown.replace(
    /^[\*\+\-]\s(.*)/gm,
    (_, item) => `<li>${item}</li>`
  );
  markdown = markdown.replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');

  // Handle inline code
  markdown = markdown.replace(
    /`(.*?)`/g,
    (_, code) => `<code>${escapeCurlyBraces(code)}</code>`
  );

  // Convert bold text: *text*
  markdown = markdown.replace(/\*(.*?)\*/g, '<strong>$1</strong>');

  // Convert italic text: _text_
  markdown = markdown.replace(/_(.*?)_/g, '<em>$1</em>');

  // Convert strikethrough: ~text~
  markdown = markdown.replace(/~(.*?)~/g, '<del>$1</del>');

  // Convert new lines to <br> for lines not inside block elements
  markdown = markdown.replace(
    /^(?!<li>|<\/li>|<ol>|<\/ol>|<ul>|<\/ul>|<pre>|<\/pre>|<blockquote>|<\/blockquote>).*$/gm,
    '$&<br>'
  );

  return markdown;
}

function escapeCurlyBraces(code: string): string {
  return code.replace(/{{(.*?)}}/g, '&lcub;&lcub;$1&rcub;&rcub;');
}
