import { NextResponse, NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';
import { eq, is } from 'drizzle-orm';
import { slackConnection, SlackConnection } from '@/lib/schema';
import { Client } from '@upstash/qstash';

export const runtime = 'edge';

export async function POST(request: NextRequest) {
  // Clone the request before consuming since we
  // need is as text and json
  const jsonClone = request.clone();
  const textClone = request.clone();

  // Parse the request body
  const requestBody = await jsonClone.json();
  console.log(JSON.stringify(requestBody, null, 2));

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

  if (isHomeInteractionEvent(eventType)) {
    console.log(`Sending UI event ${eventType}:${eventSubtype} to qstash`);
    try {
      const qstash = new Client({ token: process.env.QSTASH_TOKEN! });
      await qstash.publishJSON({
        url: `${process.env.ROOT_URL}/api/v1/slack/worker/dashboard`,
        body: { eventBody: requestBody, connectionDetails: connectionDetails },
        contentBasedDeduplication: true,
        retries: 1
      });
    } catch (error) {
      console.error('Error publishing dashboard event to qstash:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  } else if (
    isMessageToQueue(eventType, eventSubtype) ||
    (eventType === 'message' &&
      isPayloadEligibleForTicket(requestBody, connectionDetails))
  ) {
    console.log(`Publishing event ${eventType}:${eventSubtype} to qstash`);
    try {
      const qstash = new Client({ token: process.env.QSTASH_TOKEN! });
      await qstash.publishJSON({
        url: `${process.env.ROOT_URL}/api/v1/slack/worker/messages`,
        body: { eventBody: requestBody, connectionDetails: connectionDetails },
        contentBasedDeduplication: true
      });
    } catch (error) {
      console.error('Error publishing message qstash:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  } else if (eventSubtype === 'file_share') {
    // handle file_share messages differently by processing the file first
    console.log(`Publishing event ${eventType}:${eventSubtype} to qstash`);
    try {
      const qstash = new Client({ token: process.env.QSTASH_TOKEN! });
      await qstash.publishJSON({
        url: `${process.env.ROOT_URL}/api/v1/slack/worker/files`,
        body: { eventBody: requestBody, connectionDetails: connectionDetails },
        contentBasedDeduplication: true,
        retries: 1,
        failureCallback: `${process.env.ROOT_URL}/api/v1/slack/worker/messages`
      });
    } catch (error) {
      console.error('Error publishing file to qstash:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  } else {
    console.log(
      `No processable event type found for event: ${JSON.stringify(
        requestBody.event,
        null,
        2
      )}`
    );
  }

  return new NextResponse('Ok', { status: 202 });
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

  // Shouldn't need this if we explicitly check for message subtype
  // for example 'message_changed' is hidden but still needs processing
  // Ignore hidden messages
  // if (eventData.hidden) {
  //   console.log('Ignoring hidden message');
  //   return false;
  // }

  // Ignore subtypes that are not processable
  // by the message handler
  const eligibleSubtypes = new Set([
    'message_replied',
    'message_changed',
    'message_deleted',
    undefined
  ]);

  const subtype = eventData.subtype;
  if (eligibleSubtypes.has(subtype)) {
    return true;
  }

  console.log(`Ignoring message subtype: ${subtype}`);
  return false;
}

function isMessageToQueue(eventType: string, eventSubtype: string): boolean {
  const specificEventsToHandle = ['member_joined_channel', 'channel_left'];
  return (
    specificEventsToHandle.includes(eventType) ||
    specificEventsToHandle.includes(eventSubtype)
  );
}

function isHomeInteractionEvent(eventType: string): boolean {
  const specificEventsToHandle = ['app_home_opened'];
  return specificEventsToHandle.includes(eventType);
}
