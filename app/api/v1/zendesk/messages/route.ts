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

const DEFAULT_REQUESTER_EMAIL = 'no-reply@zensync.co';

export async function POST(request: NextRequest) {
  const requestBody = await request.json();
  console.log(JSON.stringify(requestBody, null, 2));

  // Save some database calls if it's a message from Zensync
  if (requestBody.current_user_email === DEFAULT_REQUESTER_EMAIL) {
    console.log('Message from Zensync, skipping');
    return NextResponse.json({ message: 'Ok' }, { status: 200 });
  }

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

  console.log(
    `ConversationInfo retrieved: ${JSON.stringify(conversationInfo)}`
  );

  // To be safe I should double-check the organization_id owns the channel_id
  if (
    !conversationInfo.channel ||
    !conversationInfo.channel.slackChannelId ||
    conversationInfo.channel.organizationId !== organizationId
  ) {
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
      { status: 404 }
    );
  }

  console.log(
    `SlackConnectionInfo retrieved: ${JSON.stringify(slackConnectionInfo)}`
  );

  try {
    await sendSlackMessage(
      requestBody,
      slackConnectionInfo,
      conversationInfo.slackParentMessageId,
      conversationInfo.channel.slackChannelId
    );
  } catch (error) {
    console.error(error);
    return NextResponse.json({ message: 'Error' }, { status: 500 });
  }

  return NextResponse.json({ message: 'Ok' }, { status: 200 });
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

async function getSlackUser(
  connection: SlackConnection,
  email: string
): Promise<{ username: string; imageUrl: string }> {
  try {
    const response = await fetch(
      `https://slack.com/api/users.lookupByEmail?email=${email}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Bearer ${connection.token}`
        }
      }
    );

    const responseData = await response.json();

    if (!responseData.ok) {
      throw new Error(`Error getting Slack user: ${responseData.error}`);
    }

    const username = responseData.user.profile.display_name;
    const imageUrl = responseData.user.profile.image_192;
    return { username, imageUrl };
  } catch (error) {
    console.error('Error in getSlackUser:', error);
    throw error;
  }
}

async function sendSlackMessage(
  requestBody: any,
  connection: SlackConnection,
  parentMessageId: string,
  slackChannelId: string
) {
  let username: string | undefined = requestBody.current_user_name;
  let imageUrl: string | undefined;

  try {
    const slackUser = await getSlackUser(
      connection,
      requestBody.current_user_email
    );
    username = slackUser.username;
    imageUrl = slackUser.imageUrl;
  } catch (error) {
    console.warn('Error getting Slack user:', error);
  }

  try {
    const body = JSON.stringify({
      channel: slackChannelId,
      text: requestBody.message,
      thread_ts: parentMessageId,
      username: username,
      icon_url: imageUrl
    });

    console.log(`Sending Slack message: ${body}`);

    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${connection.token}`
      },
      body: body
    });

    console.log(`Slack response: ${JSON.stringify(response)}`);

    const responseData = await response.json();

    if (!responseData.ok) {
      throw new Error(`Error posting message: ${responseData.error}`);
    }
  } catch (error) {
    console.error('Error in sendSlackMessage:', error);
    throw error;
  }

  console.log('Message posted successfully');
}
