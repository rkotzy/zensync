import { NextResponse, NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import {
  zendeskConnection,
  conversation,
  SlackConnection,
  slackConnection
} from '@/lib/schema';

export const runtime = 'edge';

export async function POST(request: NextRequest) {
  const requestBody = await request.json();
  console.log(JSON.stringify(requestBody, null, 2));

  // Authenticate the request and get organization_id
  const organizationId = await authenticateRequest(request);
  if (!organizationId) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  // Get the conversation from external_id
  const conversationInfo = await db.query.conversation.findFirst({
    where: eq(conversation.id, requestBody.external_id),
    with: {
      channel: true
    }
  });

  if (!conversationInfo?.slackParentMessageId) {
    console.error(`No conversation found for id ${requestBody.external_id}`);
    return NextResponse.json(
      { message: 'No conversation found' },
      { status: 404 }
    );
  }

  // To be safe I should double-check the organization_id owns the channel_id
  const channel: any = conversationInfo?.channel;
  if (!channel?.slackChannelId || channel?.organizationId !== organizationId) {
    console.warn(`Invalid Ids: ${organizationId} !== ${conversationInfo}`);
    return NextResponse.json({ message: 'Invalid Ids' }, { status: 401 });
  }

  // Create a Slack message in a thread from parent message id
  const slackConnectionInfo: SlackConnection | undefined =
    await db.query.slackConnection.findFirst({
      where: eq(slackConnection.organizationId, organizationId)
    });

  if (!slackConnectionInfo) {
    console.error(`No Slack connection found for org ${organizationId}`);
    return NextResponse.json(
      { message: 'No Slack connection found' },
      { status: 500 }
    );
  }

  try {
    sendSlackMessage(
      requestBody,
      slackConnectionInfo,
      conversationInfo.slackParentMessageId,
      channel.slackChannelId
    );
  } catch (error) {
    console.error(error);
    return NextResponse.json({ message: 'Error' }, { status: 500 });
  }

  return NextResponse.json({ message: 'Ok' }, { status: 500 });
}

async function authenticateRequest(
  request: NextRequest
): Promise<string | null> {
  const authorizationHeader = request.headers.get('authorization');
  const bearerToken = authorizationHeader?.replace('Bearer ', '');
  if (!bearerToken) {
    console.error('Missing bearer token');
    return null;
  }

  const connection = await db.query.zendeskConnection.findFirst({
    where: eq(zendeskConnection.id, bearerToken)
  });

  if (!connection) {
    console.error('Invalid bearer token');
    return null;
  }

  return connection.organizationId;
}

async function sendSlackMessage(
  requestBody: any,
  connection: SlackConnection,
  parentMessageId: string,
  slackChannelId: string
) {
  const body = JSON.stringify({
    channel: slackChannelId,
    text: requestBody.message,
    thread_ts: parentMessageId
  });

  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${connection.token}`
    },
    body: body
  });

  const responseData = await response.json();

  if (!responseData.ok) {
    throw new Error(`Error posting message: ${responseData.error}`);
  }

  console.log('Message posted successfully:', responseData);
}
