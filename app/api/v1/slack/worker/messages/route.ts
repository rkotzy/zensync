import { NextResponse, NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';
import { eq, and } from 'drizzle-orm';
import {
  channel,
  SlackConnection,
  zendeskConnection,
  ZendeskConnection,
  conversation
} from '@/lib/schema';
import { SlackMessageData } from '@/interfaces/slack-api.interface';
import { verifySignatureEdge } from '@upstash/qstash/dist/nextjs';

export const runtime = 'edge';

const eventHandlers: Record<
  string,
  (body: any, connection: SlackConnection) => Promise<void>
> = {
  member_joined_channel: handleChannelJoined,
  channel_left: handleChannelLeft,
  message: handleMessage,
  file_share: handleFileUpload,
  message_changed: handleMessageEdit
  // Add more event handlers as needed
};

export const POST = verifySignatureEdge(handler);
async function handler(request: NextRequest) {
  let requestJson = await request.json();
  console.log(JSON.stringify(requestJson, null, 2));

  // This checks for a case where the request is a callback from Qstash
  if (
    request.headers.get('User-Agent') === 'Upstash-QStash' &&
    requestJson.sourceBody
  ) {
    console.log(`Qstash callback detected.`);
    requestJson = parseQstashCallback(requestJson);
    console.log(JSON.stringify(requestJson, null, 2));
  }

  const requestBody = requestJson.eventBody;
  const connectionDetails = requestJson.connectionDetails;
  if (!connectionDetails) {
    console.error('No connection details found');
    return new NextResponse('No connection details found.', { status: 500 });
  }

  const eventType = requestBody.event?.type;
  const eventSubtype = requestBody.event?.subtype;

  if (eventSubtype && eventHandlers[eventSubtype]) {
    try {
      await eventHandlers[eventSubtype](requestBody, connectionDetails);
    } catch (error) {
      console.error(`Error handling ${eventSubtype} subtype event:`, error);
      return new NextResponse('Internal Server Error', { status: 500 });
    }
  } else if (eventType && eventHandlers[eventType]) {
    try {
      await eventHandlers[eventType](requestBody, connectionDetails);
    } catch (error) {
      console.error(`Error handling ${eventType} event:`, error);
      return new NextResponse('Internal Server Error', { status: 500 });
    }
  } else {
    console.warn(`No handler for event type: ${eventType}`);
  }

  return new NextResponse('Ok', { status: 202 });
}

function parseQstashCallback(request: any): any {
  if (!request.sourceBody) {
    console.log('No qstash source body');
    return request;
  }

  try {
    const base64Decoded = atob(request.sourceBody);
    const response = JSON.parse(base64Decoded);
    return response;
  } catch (error) {
    console.error('Error parsing qstash callback body:', error);
    return request;
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

async function handleFileUpload(
  request: any,
  connection: SlackConnection,
  isPublic: boolean = true
) {
  if (request.zendeskFileTokens) {
    console.log('File upload handled successfully');
    return await handleMessage(request, connection);
  } else {
    console.log('Need to handle file fallback');

    const files = request.event.files;

    // Check if there are files
    if (!files || files.length === 0) {
      console.log('No files found in fallback');
      return await handleMessage(request, connection);
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
    console.log(`Updated request: ${JSON.stringify(request, null, 2)}`);
    return await handleMessage(request, connection, isPublic);
  }
}

async function handleMessageEdit(request: any, connection: SlackConnection) {
  // TODO: - these edits come through at a different level than a regular message handler.
  // Need to rebuild the request object to match the regular message handler and
  // start by running it through the handleFileUpload function to set any file attachments
  // that may have been added.

  if (request.event?.message) {
    console.log('Handling message edit');
    request.event = request.event.message;
    request.event.text = `\n\n<strong>(Edited)</strong>\n\n${request.event.text}`;

    return await handleFileUpload(request, connection, false);
  } else {
    console.log('Unknown message edit type:', request);
    return await handleMessage(request, connection, false);
  }
}

async function handleMessage(
  request: any,
  connection: SlackConnection,
  isPublic: boolean = true
) {
  // We should only have this code in one place but might want
  // To introduce it here too
  // if (!isPayloadEligibleForTicket(request, connection)) {
  //   return;
  // }

  // Build the message data interface
  const messageData = request.event as SlackMessageData;
  if (!messageData || messageData.type !== 'message') {
    console.error('Invalid message payload');
    return;
  }
  console.log('SlackMessageData:', messageData);

  // Set any file upload data
  const fileUploadTokens: string[] | undefined = request.zendeskFileTokens;
  console.log(`Upload tokens: ${fileUploadTokens}`);

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
  console.log('Get or create user call:', messageData);
  let zendeskUserId: number | undefined;
  try {
    zendeskUserId = await getOrCreateZendeskUser(
      connection,
      zendeskCredentials,
      messageData
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
        zendeskUserId,
        fileUploadTokens,
        isPublic
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
      zendeskUserId,
      fileUploadTokens,
      isPublic
    );
  } catch (error) {
    console.error('Error creating new conversation:', error);
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
  messageData: SlackMessageData
): Promise<number | undefined> {
  const zendeskAuthToken = btoa(
    `${zendeskCredentials.zendeskEmail}/token:${zendeskCredentials.zendeskApiKey}`
  );

  console.log('Creating zendesk user with data:', messageData);

  const slackChannelId = messageData.channel;

  if (!messageData.user) {
    console.error('No slack user found:', messageData);
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
    console.log(`Getting Slack user ${userId}`);
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

    console.log(
      `Slack user response: ${JSON.stringify(responseData, null, 2)}`
    );

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
  authorId: number,
  fileUploadTokens: string[] | undefined,
  isPublic: boolean
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

  let htmlBody = slackMarkdownToHtml(messageData.text);
  if (!htmlBody || htmlBody === '') {
    htmlBody = '<i>(Empty message)</i>';
  }

  // Create a comment in ticket
  let commentData: any = {
    ticket: {
      comment: {
        html_body: htmlBody,
        public: isPublic,
        author_id: authorId
      },
      status: 'open'
    }
  };

  if (fileUploadTokens && fileUploadTokens.length > 0) {
    commentData.ticket.comment.uploads = fileUploadTokens;
  }

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

  const responseData = await response.json();
  console.log('Ticket comment response data:', responseData);

  if (!response.ok) {
    console.error('Error updating ticket comment:', response);
    throw new Error('Error creating comment');
  }

  // TODO: - Update last message ID conversation
}

async function handleNewConversation(
  messageData: SlackMessageData,
  zendeskCredentials: ZendeskConnection,
  channelId: string,
  authorId: number,
  fileUploadTokens: string[] | undefined,
  isPublic: boolean
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

  let htmlBody = slackMarkdownToHtml(messageData.text);
  if (!htmlBody || htmlBody === '') {
    htmlBody = '<i>(Empty message)</i>';
  }

  // Create a ticket in Zendesk
  // TODO: - Add assignee_email
  let ticketData: any = {
    ticket: {
      subject: `${channelInfo?.name}: ${
        messageData.text?.substring(0, 69) ?? ''
      }...`,
      comment: {
        html_body: htmlBody,
        public: isPublic
      },
      requester_id: authorId,
      external_id: conversationUuid,
      tags: ['zensync']
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
