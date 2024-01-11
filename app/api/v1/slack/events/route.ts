import { NextResponse, NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import { createHmac } from 'crypto';
import { timingSafeEqual } from 'crypto';
import { channel, slackConnection } from '@/lib/schema';

export const runtime = 'edge';

export async function POST(request: NextRequest) {
  // Retrieve the Slack signing secret
  const signingSecret = process.env.SLACK_SIGNING_SECRET!;

  // Verify the Slack request
  if (!(await verifySlackRequest(request, signingSecret))) {
    console.warn('Slack verification failed!');
    return new Response('Verification failed', { status: 200 });
  }

  // Parse the request body
  const requestBody = await request.json();

  // Log the request body
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

  // Check for channel_joined event
  if (requestBody.event && requestBody.event.subtype === 'channel_join') {
    try {
      // Attempt to handle the channel_joined event
      await handleChannelJoined(requestBody);
    } catch (error) {
      console.error('Error handling channel_joined event:', error);
      // Handle the error appropriately
      // Depending on your application's needs, you may choose to send a specific response
      return new Response('Internal Server Error', { status: 500 });
    }
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

async function handleChannelJoined(requestBody: any) {
  // Extract the event and team_id from the request body
  const eventData = requestBody.event;
  const teamId = requestBody.team_id;

  const channelId = eventData.channel;
  const channelType = eventData.channel_type;

  // Find the corresponding organizationId
  const organizationId = await findOrganizationByTeamId(teamId);

  if (organizationId === null) {
    console.warn(
      `No organization found for team ID: ${teamId}. Channel not added.`
    );
    throw new Error(`No organization associated with team ID: ${teamId}`);
  }
  // Create a new entry in the channels table
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
