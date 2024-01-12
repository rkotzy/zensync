import { NextResponse, NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';
import { eq, and } from 'drizzle-orm';
import { channel, slackConnection, SlackConnection } from '@/lib/schema';
import { SlackMessageData } from '@/interfaces/slack-api.interface';

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

  if (eventSubtype && eventHandlers[eventSubtype]) {
    try {
      await eventHandlers[eventSubtype](requestBody, connectionDetails);
    } catch (error) {
      console.error(`Error handling ${eventSubtype} subtype event:`, error);
      return new Response('Internal Server Error', { status: 500 });
    }
  } else if (eventType && eventHandlers[eventType]) {
    try {
      await eventHandlers[eventType](requestBody, connectionDetails);
    } catch (error) {
      console.error(`Error handling ${eventType} event:`, error);
      return new Response('Internal Server Error', { status: 500 });
    }
  } else {
    console.warn(`No handler for event type: ${eventType}`);
  }

  return NextResponse.json({ message: 'Ok' }, { status: 200 });
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
  const channelType = eventData.channel_type;

  if (connection.botUserId !== eventData.user) {
    return;
  }

  try {
    await db
      .insert(channel)
      .values({
        organizationId: connection.organizationId,
        slackChannelId: channelId,
        slackChannelType: channelType,
        status: 'ACTIVE'
      })
      .onConflictDoUpdate({
        target: [channel.organizationId, channel.slackChannelId],
        set: { status: 'ACTIVE' }
      });

    console.log(
      `Channel ${channelId} added to the database with organization ID ${connection.organizationId}.`
    );
  } catch (error) {
    console.error('Error saving channel to database:', error);
    throw error;
  }
}

async function handleChannelLeft(request: any, connection: SlackConnection) {
  const eventData = request.event;
  const channelId = eventData.channel;

  try {
    await db
      .update(channel)
      .set({
        status: 'ARCHIVED'
      })
      .where(
        and(
          eq(channel.organizationId, connection.organizationId),
          eq(channel.slackChannelId, channelId)
        )
      );

    console.log(`Channel ${channelId} archived.`);
  } catch (error) {
    console.error('Error archiving channel in database:', error);
    throw error;
  }
}

async function handleMessage(request: any, connection: SlackConnection) {
  // Check the payload to see if we can quickly ignore
  if (!isPayloadEligibleForTicket(request, connection)) {
    console.log(`Ignoring message: ${request.event_id}`);
    return;
  }

  // Build the message data interface
  const messageData = request.event as SlackMessageData;
  if (!messageData || messageData.type !== 'message') {
    console.error('Invalid message payload');
    return;
  }

  // Check if message is already part of a thread
  if (isChildMessage(messageData)) {
    // Handle child message
    // If thread, see if parent message ID exists in conversations table
    console.log(`Handling child message`);
    return;
  }

  // See if "same-sender timeframe" applies
  const existingConversationId = await sameSenderConversationId();
  if (existingConversationId) {
    // Add message to existing conversation
    console.log(`Adding message to existing conversation`);
    return;
  }

  // Create zendesk ticket + conversation + message in transaction
  console.log(`Creating new conversation`);
  handleNewConversation();

  console.log(`Handling message: ${request.event_id}`);
}

function isPayloadEligibleForTicket(
  request: any,
  connection: SlackConnection
): boolean {
  const eventData = request.event;

  // Ignore messages from the Zensync itself
  if (connection.botUserId === eventData.user) {
    return false;
  }

  // Ignore messages from bots
  if (eventData.subtype === 'bot_message') {
    return false;
  }

  return true;
}

function isChildMessage(event: SlackMessageData): boolean {
  if (event.thread_ts) {
    if (event.thread_ts === event.ts) {
      return false;
    } else {
      return true;
    }
  }

  return false;
}

async function sameSenderConversationId(): Promise<string | null> {
  // Get the most recent conversation for this channel
  // If the sender is the same and within timeframe, return the conversation ID
  // Otherwise, return null
  return null;
}

async function handleNewConversation() {
  // Create Zendesk ticket
  // Create conversation
  // Create message
}
