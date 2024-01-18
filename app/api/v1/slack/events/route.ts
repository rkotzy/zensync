import { NextResponse, NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';
import { eq, and, is } from 'drizzle-orm';
import {
  channel,
  slackConnection,
  SlackConnection,
  zendeskConnection,
  ZendeskConnection,
  conversation
} from '@/lib/schema';
import { SlackMessageData } from '@/interfaces/slack-api.interface';
import { Client } from '@upstash/qstash';

export const runtime = 'edge';

const eventHandlers: Record<
  string,
  (body: any, connection: SlackConnection) => Promise<void>
> = {
  member_joined_channel: handleChannelJoined,
  channel_left: handleChannelLeft,
  message: handleMessage
  // Add more event handlers as needed
};

export async function POST(request: NextRequest) {
  // Clone the request before consuming since we
  // need is as text and json
  const jsonClone = request.clone();
  const textClone = request.clone();

  // Parse the request body
  const requestBody = await jsonClone.json();

  // Check if this is a URL verification request from Slack
  if (requestBody.type === 'url_verification') {
    // Respond with the challenge value
    return new Response(requestBody.challenge, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain'
      }
    });
  }

  // Retrieve the Slack signing secret
  const signingSecret = process.env.SLACK_SIGNING_SECRET!;

  // Verify the Slack request
  if (!(await verifySlackRequest(textClone, signingSecret))) {
    console.warn('Slack verification failed!');
    return new Response('Verification failed', { status: 200 });
  }

  // Log the request body
  console.log(JSON.stringify(requestBody, null, 2));

  ///////////////////////////////////////
  // Handle events that require an organization details
  ///////////////////////////////////////

  // Find the corresponding organization connection details
  const connectionDetails = await findSlackConnectionByTeamId(
    requestBody.team_id
  );

  if (!connectionDetails) {
    console.warn(`No organization found for team ID: ${requestBody.team_id}.`);
    return new Response('Invalid team_id', { status: 404 });
  }

  const eventType = requestBody.event?.type;
  const eventSubtype = requestBody.event?.subtype;

  // TODO: - This is a hacky way to handle events and the logic is error prone
  const eventsToHandle = ['member_joined_channel', 'channel_left', 'message'];
  if (
    eventsToHandle.includes(eventSubtype) ||
    eventsToHandle.includes(eventType)
  ) {
    if (
      eventType !== 'message' ||
      isPayloadEligibleForTicket(requestBody, connectionDetails)
    ) {
      console.log(`Publishing event ${eventType}:${eventSubtype} to qstash`);
      try {
        const qstash = new Client({ token: process.env.QSTASH_TOKEN! });
        const qstashResponse = await qstash.publishJSON({
          url: 'https://zensync.vercel.app/api/v1/slack/worker',
          body: { eventBody: requestBody, connectionDetails: connectionDetails }
        });
      } catch (error) {
        console.error('Error publishing to qstash:', error);
        return new Response('Internal Server Error', { status: 500 });
      }
    } else {
      console.log(`Unproccessable message subtype: ${eventSubtype}`);
    }
  } else {
    console.log(
      `No event type found for event: ${JSON.stringify(
        requestBody.event,
        null,
        2
      )}`
    );
  }

  return NextResponse.json({ message: 'Ok' }, { status: 200 });

  // if (eventSubtype && eventHandlers[eventSubtype]) {
  //   try {
  //     await eventHandlers[eventSubtype](requestBody, connectionDetails);
  //   } catch (error) {
  //     console.error(`Error handling ${eventSubtype} subtype event:`, error);
  //     return new Response('Internal Server Error', { status: 500 });
  //   }
  // } else if (eventType && eventHandlers[eventType]) {
  //   try {
  //     await eventHandlers[eventType](requestBody, connectionDetails);
  //   } catch (error) {
  //     console.error(`Error handling ${eventType} event:`, error);
  //     return new Response('Internal Server Error', { status: 500 });
  //   }
  // } else {
  //   console.warn(`No handler for event type: ${eventType}`);
  // }

  // return NextResponse.json({ message: 'Ok' }, { status: 200 });
}

async function verifySlackRequest(
  request: Request,
  signingSecret: string
): Promise<boolean> {
  const timestamp = request.headers.get('x-slack-request-timestamp');
  const slackSignature = request.headers.get('x-slack-signature');
  const body = await request.text();

  const basestring = `v0:${timestamp}:${body}`;

  // Convert the Slack signing secret and the basestring to Uint8Array
  const encoder = new TextEncoder();
  const keyData = encoder.encode(signingSecret);
  const data = encoder.encode(basestring);

  // Import the signing secret key for use with HMAC
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  // Create HMAC and get the signature as hex string
  const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, data);
  const mySignature = Array.from(new Uint8Array(signatureBuffer))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');

  const computedSignature = `v0=${mySignature}`;

  // Compare the computed signature and the Slack signature
  return timingSafeEqual(computedSignature, slackSignature || '');
}

// Timing-safe string comparison used in verifySlackRequest
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return mismatch === 0;
}

async function findSlackConnectionByTeamId(
  teamId: string | undefined
): Promise<SlackConnection | null | undefined> {
  if (!teamId) {
    console.error('No team_id found');
    return undefined;
  }

  try {
    const connection = await db.query.slackConnection.findFirst({
      where: eq(slackConnection.slackTeamId, teamId)
    });

    return connection;
  } catch (error) {
    console.error('Error querying SlackConnections:', error);
    return undefined;
  }
}

async function handleChannelJoined(request: any, connection: SlackConnection) {
  const eventData = request.event;
  const channelId = eventData.channel;

  if (connection.botUserId !== eventData.user) {
    return;
  }

  try {
    // Fetch channel info from Slack
    const params = new URLSearchParams();
    params.append('channel', channelId);

    const response = await fetch(
      `https://slack.com/api/conversations.info?${params.toString()}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Bearer ${connection.token}`
        }
      }
    );

    const responseData = await response.json();
    console.log('Channel info recieved:', responseData);

    if (!responseData.ok) {
      console.warn('Failed to fetch channel info:', response.statusText);
      throw new Error('Failed to fetch channel info');
    }

    const channelType = getChannelType(responseData.channel);
    const channelName = responseData.channel?.name;
    const isShared =
      responseData.channel?.is_shared ||
      responseData.channel?.is_pending_ext_shared;

    // Save or update channel in database
    await db
      .insert(channel)
      .values({
        organizationId: connection.organizationId,
        slackChannelId: channelId,
        type: channelType,
        isMember: true,
        name: channelName,
        isShared: isShared
      })
      .onConflictDoUpdate({
        target: [channel.organizationId, channel.slackChannelId],
        set: {
          type: channelType,
          isMember: true,
          name: channelName,
          isShared: isShared
        }
      });

    console.log(
      `Channel ${channelId} added to the database with organization ID ${connection.organizationId}.`
    );
  } catch (error) {
    console.error('Error saving channel to database:', error);
    throw error;
  }
}

function getChannelType(channelData: any): string | null {
  if (typeof channelData !== 'object' || channelData === null) {
    console.warn('Invalid or undefined channel data received:', channelData);
    return null;
  }

  if (channelData.is_channel) {
    return 'PUBLIC';
  } else if (channelData.is_group) {
    return 'PRIVATE';
  } else if (channelData.is_im) {
    return 'DM';
  } else if (channelData.is_mpim) {
    return 'GROUP_DM';
  }

  console.warn(`Unkonwn channel type: ${channelData}`);
  return null;
}

async function handleChannelLeft(request: any, connection: SlackConnection) {
  const eventData = request.event;
  const channelId = eventData.channel;

  try {
    await db
      .update(channel)
      .set({
        isMember: false
      })
      .where(
        and(
          eq(channel.organizationId, connection.organizationId),
          eq(channel.slackChannelId, channelId)
        )
      );

    console.log(`Channel ${channelId} left.`);
  } catch (error) {
    console.error('Error archiving channel in database:', error);
    throw error;
  }
}

async function handleMessage(request: any, connection: SlackConnection) {
  // Check the payload to see if we can quickly ignore
  if (!isPayloadEligibleForTicket(request, connection)) {
    return;
  }

  // Build the message data interface
  const messageData = request.event as SlackMessageData;
  if (!messageData || messageData.type !== 'message') {
    console.error('Invalid message payload');
    return;
  }

  // Fetch Zendesk credentials
  let zendeskCredentials: ZendeskConnection | null;
  try {
    zendeskCredentials = await fetchZendeskCredentials(
      connection.organizationId
    );
  } catch (error) {
    console.error(error);
    throw new Error('Error fetching Zendesk credentials');
  }
  if (!zendeskCredentials) {
    console.error(
      `No Zendesk credentials found for org: ${connection.organizationId}`
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
      messageData.channel
    );
  } catch (error) {
    console.error('Error getting or creating Zendesk user:', error);
    throw error;
  }
  if (!zendeskUserId) {
    console.error('No Zendesk user ID');
    throw new Error('No Zendesk user ID');
  }

  // Check if message is already part of a thread
  const parentMessageId = getParentMessageId(messageData);
  if (parentMessageId) {
    // Handle child message
    console.log(`Handling child message`);
    try {
      await handleThreadReply(
        messageData,
        zendeskCredentials,
        connection.organizationId,
        messageData.channel,
        parentMessageId,
        zendeskUserId
      );
    } catch (error) {
      console.error('Error handling thread reply:', error);
      throw error;
    }
    return;
  }

  // See if "same-sender timeframe" applies
  const existingConversationId = await sameSenderConversationId();
  if (existingConversationId) {
    // Add message to existing conversation
    console.log(`Adding message to existing conversation`);
    return;
  }

  // Create zendesk ticket + conversation
  try {
    console.log(`Creating new conversation`);
    await handleNewConversation(
      messageData,
      zendeskCredentials,
      messageData.channel,
      zendeskUserId
    );
  } catch (error) {
    console.error('Error creating new conversation:', error);
    throw error;
  }
}

function isPayloadEligibleForTicket(
  request: any,
  connection: SlackConnection
): boolean {
  const eventData = request.event;

  // Ignore messages from the Zensync itself
  if (connection.botUserId === eventData.user) {
    console.log('Ignoring message from Zensync');
    return false;
  }

  // Ignore hidden messages
  if (eventData.hidden) {
    console.log('Ignoring hidden message');
    return false;
  }

  // Ignore subtypes that are not processable
  // by the message handler
  const eligibleSubtypes = new Set(['message_replied', undefined]);

  const subtype = eventData.subtype;
  if (eligibleSubtypes.has(subtype)) {
    return true;
  }

  console.log(`Ignoring message subtype: ${subtype}`);
  return false;
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
  slackChannelId: string
): Promise<number | undefined> {
  const zendeskAuthToken = btoa(
    `${zendeskCredentials.zendeskEmail}/token:${zendeskCredentials.zendeskApiKey}`
  );

  try {
    const { username, imageUrl } = await getSlackUser(
      slackConnection,
      messageData.user
    );

    const zendeskUserData = {
      user: {
        name: `${username} (via Slack)` || 'Unknown Slack user',
        skip_verify_email: true,
        external_id: `zensync-${slackChannelId}:${messageData.user}`,
        remote_photo_url: imageUrl
      }
    };

    console.log(`Upserting user data: ${JSON.stringify(zendeskUserData)}`);

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
      console.error('Error updating user:', response);
      throw new Error('Error updating or creating user');
    }

    const responseData = await response.json();
    console.log('User created or updated:', responseData);

    return responseData.user.id;
  } catch (error) {
    console.error('Error creating or updating user:', error);
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
  userId: string
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

    const responseData = await response.json();

    console.log(`Slack user response: ${JSON.stringify(responseData)}`);

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
    console.error('Error in getSlackUser:', error);
    throw error;
  }
}

async function handleThreadReply(
  messageData: SlackMessageData,
  zendeskCredentials: ZendeskConnection,
  organizationId: string,
  channelId: string,
  slackParentMessageId: string,
  authorId: number
) {
  // get conversation from database
  const conversationInfo = await db
    .select({
      zendeskTicketId: conversation.zendeskTicketId
    })
    .from(conversation)
    .innerJoin(channel, eq(conversation.channelId, channel.id))
    .where(
      and(
        eq(channel.slackChannelId, channelId),
        eq(conversation.slackParentMessageId, slackParentMessageId),
        eq(channel.organizationId, organizationId)
      )
    )
    .limit(1);

  if (conversationInfo.length === 0 || !conversationInfo[0].zendeskTicketId) {
    console.error('No conversation found');
    throw new Error('No conversation found');
  }

  // Create ticket comment indepotently using Slack message ID + channel ID?
  const idempotencyKey = channelId + messageData.ts;
  const zendeskAuthToken = btoa(
    `${zendeskCredentials.zendeskEmail}/token:${zendeskCredentials.zendeskApiKey}`
  );

  // Create a comment in ticket
  const commentData = {
    ticket: {
      comment: {
        body: messageData.text,
        public: true,
        author_id: authorId
      },
      status: 'open'
    }
  };

  const response = await fetch(
    `https://${zendeskCredentials.zendeskDomain}.zendesk.com/api/v2/tickets/${conversationInfo[0].zendeskTicketId}.json`,
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

  if (!response.ok) {
    console.error('Error updating ticket comment:', response);
    throw new Error('Error creating comment');
  }

  const responseData = await response.json();
  console.log('Ticket comment updated:', responseData);

  // TODO: - Update last message ID conversation
}

async function handleNewConversation(
  messageData: SlackMessageData,
  zendeskCredentials: ZendeskConnection,
  channelId: string,
  authorId: number
) {
  // Fetch channel info
  const channelInfo = await db.query.channel.findFirst({
    where: eq(channel.slackChannelId, channelId)
  });

  // Create Zendesk ticket indepotently using Slack message ID + channel ID?
  const idempotencyKey = channelId + messageData.ts;
  const zendeskAuthToken = btoa(
    `${zendeskCredentials.zendeskEmail}/token:${zendeskCredentials.zendeskApiKey}`
  );

  // Set the primary key for the conversation
  let conversationUuid = crypto.randomUUID();

  if (!channelInfo) {
    console.warn(`No channel found: ${channelId}`);
    throw new Error(`No channel found`);
  }

  if (!channelInfo.name) {
    console.warn(`No channel name found, continuing: ${channelInfo}`);
  }

  // Create a ticket in Zendesk
  // TODO: - Add assignee_email
  const ticketData = {
    ticket: {
      subject: `${channelInfo?.name}: ${
        messageData.text?.substring(0, 69) ?? ''
      }...`,
      comment: {
        body: messageData.text
      },
      requester_id: authorId,
      external_id: conversationUuid,
      tags: ['zensync']
    }
  };

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

    const responseData = await response.json();
    console.log('Ticket response data:', responseData);

    if (!response.ok) {
      console.error('Response is not okay:', response);
      throw new Error('Error creating ticket');
    }

    ticketId = responseData.ticket.id;
  } catch (error) {
    console.error('Error creating ticket:', error);
    throw error;
  }

  if (!ticketId) {
    console.error('No ticket ID');
    throw new Error('No ticket ID');
  }

  // Create conversation
  // TODO: - Have a last message ID column
  await db.insert(conversation).values({
    id: conversationUuid,
    channelId: channelInfo.id,
    slackParentMessageId: messageData.ts,
    zendeskTicketId: ticketId,
    slackAuthorUserId: messageData.user
  });
}

async function fetchZendeskCredentials(
  organizationId: string
): Promise<ZendeskConnection | null> {
  const zendeskCredentials = await db.query.zendeskConnection.findFirst({
    where: eq(zendeskConnection.organizationId, organizationId)
  });
  const zendeskDomain = zendeskCredentials?.zendeskDomain;
  const zendeskEmail = zendeskCredentials?.zendeskEmail;
  const zendeskApiKey = zendeskCredentials?.zendeskApiKey;

  if (!zendeskDomain || !zendeskEmail || !zendeskApiKey) {
    console.error(
      `Invalid Zendesk credentials found for organization ${organizationId}`
    );
    return null;
  }

  return zendeskCredentials;
}
