import { NextResponse, NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import { createHmac } from 'crypto';
import { timingSafeEqual } from 'crypto';
import { channel, slackConnection } from '@/lib/schema';

export const runtime = 'edge';

const eventHandlers: Record<
  string,
  (body: any, orgId: string) => Promise<void>
> = {
  channel_join: handleChannelJoined,
  channel_left: handleChannelLeft
  // Add more event handlers as needed
};

export async function POST(request: NextRequest) {
  // Parse the request body
  const requestBody = await request.json();

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
  if (!(await verifySlackRequest(request, signingSecret))) {
    console.warn('Slack verification failed!');
    return new Response('Verification failed', { status: 200 });
  }

  // Log the request body
  console.log(JSON.stringify(requestBody, null, 2));

  ///////////////////////////////////////
  // Handle events that require an organization ID
  ///////////////////////////////////////

  // Find the corresponding organizationId
  const organizationId = await findOrganizationByTeamId(requestBody.team_id);

  if (organizationId === null) {
    console.warn(`No organization found for team ID: ${requestBody.team_id}.`);
    return new Response('Invalid team_id', { status: 404 });
  }

  const eventType = requestBody.event?.subtype;

  if (eventType && eventHandlers[eventType]) {
    try {
      await eventHandlers[eventType](requestBody, organizationId);
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
  request: NextRequest,
  signingSecret: string
): Promise<boolean> {
  const timestamp = request.headers.get('x-slack-request-timestamp');
  const slackSignature = request.headers.get('x-slack-signature');
  const body = await request.text();

  const basestring = `v0:${timestamp}:${body}`;
  const mySignature =
    'v0=' +
    createHmac('sha256', signingSecret).update(basestring).digest('hex');

  // Convert both signatures to Buffer
  const slackSignatureBuffer = Buffer.from(slackSignature || '', 'utf8');
  const mySignatureBuffer = Buffer.from(mySignature, 'utf8');

  // Check if the signature length is equal to avoid timingSafeEqual throwing an error
  if (slackSignatureBuffer.length !== mySignatureBuffer.length) {
    return false;
  }

  return timingSafeEqual(slackSignatureBuffer, mySignatureBuffer);
}

async function findOrganizationByTeamId(
  teamId: string | undefined
): Promise<string | null> {
  if (!teamId) {
    console.error('No team_id found');
    return null;
  }

  try {
    const connection = await db.query.slackConnection.findFirst({
      where: eq(slackConnection.slackTeamId, teamId)
    });

    if (connection) {
      return connection.organizationId;
    } else {
      console.log(`No SlackConnection found for team ID: ${teamId}`);
      return null;
    }
  } catch (error) {
    console.error('Error querying SlackConnections:', error);
    return null;
  }
}

async function handleChannelJoined(eventData: any, organizationId: string) {
  const channelId = eventData.channel;
  const channelType = eventData.channel_type;

  try {
    await db.insert(channel).values({
      organizationId: organizationId,
      slackChannelId: channelId,
      slackChannelType: channelType,
      status: 'ACTIVE'
    });

    console.log(
      `Channel ${channelId} added to the database with organization ID ${organizationId}.`
    );
  } catch (error) {
    console.error('Error saving channel to database:', error);
  }
}

async function handleChannelLeft(eventData: any, organizationId: string) {
  const channelId = eventData.channel;

  try {
    await db
      .update(channel)
      .set({
        status: 'ARCHIVED'
      })
      .where(eq(channel.slackChannelId, channelId));

    console.log(`Channel ${channelId} archived.`);
  } catch (error) {
    console.error('Error archiving channel in database:', error);
  }
}
