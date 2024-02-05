import { NextResponse, NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import {
  zendeskConnection,
  SlackConnection,
  slackConnection,
  conversation
} from '@/lib/schema';

export const runtime = 'edge';

export async function POST(request: NextRequest) {
  const requestBody = await request.json();
  console.log(JSON.stringify(requestBody, null, 2));

  // Save some database calls if it's a message from Zensync

  // Ignore messages from Zensync
  if (
    typeof requestBody.current_user_external_id === 'string' &&
    requestBody.current_user_external_id.startsWith('zensync')
  ) {
    console.log('Message from Zensync, skipping');
    return new NextResponse('Ok', { status: 200 });
  }

  // Make sure we have the last updated ticket time
  const ticketLastUpdatedAt = requestBody.last_updated_at;
  if (!ticketLastUpdatedAt) {
    console.error('Missing last_updated_at');
    return new NextResponse('Missing last_updated_at', { status: 400 });
  }

  // Ignore messages if last_updated_at === created_at
  // WARNING: - This would ignore messages sent in same minute.
  // Should log in Sentry probably?
  if (requestBody.last_updated_at === requestBody.created_at) {
    console.log('Message is not an update, skipping');
    return new NextResponse('Ok', { status: 200 });
  }

  // Authenticate the request and get slack connection Id
  const slackConnectionId = await authenticateRequest(request);
  if (!slackConnectionId) {
    return new NextResponse('Unauthorized', { status: 401 });
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
    return new NextResponse('No conversation found', { status: 404 });
  }

  console.log(
    `ConversationInfo retrieved: ${JSON.stringify(conversationInfo)}`
  );

  // To be safe I should double-check the organization_id owns the channel_id
  if (
    !conversationInfo.channel ||
    !conversationInfo.channel.slackChannelIdentifier ||
    conversationInfo.channel.slackConnectionId !== slackConnectionId
  ) {
    console.warn(`Invalid Ids: ${slackConnectionId} !== ${conversationInfo}`);
    return new NextResponse('Invalid Ids', { status: 401 });
  }

  // To be safe I should double-check the organization_id owns the channel_id
  if (
    !conversationInfo.channel ||
    !conversationInfo.channel.slackChannelIdentifier ||
    conversationInfo.channel.slackConnectionId !== slackConnectionId
  ) {
    console.warn(`Invalid Ids: ${slackConnectionId} !== ${conversationInfo}`);
    return new NextResponse('Invalid Ids', { status: 401 });
  }

  // Get the full slack connection info
  const slackConnectionInfo: SlackConnection | undefined =
    await db.query.slackConnection.findFirst({
      where: eq(slackConnection.id, slackConnectionId)
    });

  if (!slackConnectionInfo) {
    console.error(`No Slack connection found for id ${slackConnectionId}`);
    return new NextResponse('No Slack connection found', { status: 404 });
  }

  console.log(
    `SlackConnectionInfo retrieved: ${JSON.stringify(slackConnectionInfo)}`
  );

  try {
    await sendSlackMessage(
      requestBody,
      slackConnectionInfo,
      conversationInfo.slackParentMessageId,
      conversationInfo.channel.slackChannelIdentifier
    );
  } catch (error) {
    console.error(error);
    return new NextResponse('Error', { status: 500 });
  }

  return new NextResponse('Ok', { status: 202 });
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
    where: eq(zendeskConnection.webhookBearerToken, bearerToken)
  });

  if (!connection) {
    console.error('Invalid bearer token');
    return null;
  }

  return connection.slackConnectionId;
}

async function getSlackUser(
  connection: SlackConnection,
  email: string
): Promise<{ username: string | undefined; imageUrl: string }> {
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

    console.log(`Slack user response: ${JSON.stringify(responseData)}`);

    if (!responseData.ok) {
      throw new Error(`Error getting Slack user: ${responseData.error}`);
    }

    const username =
      responseData.user.profile.display_name ||
      responseData.user.profile.real_name ||
      undefined;
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
  let username: string | undefined;
  let imageUrl: string | undefined;

  try {
    if (requestBody.current_user_email) {
      const slackUser = await getSlackUser(
        connection,
        requestBody.current_user_email
      );
      username = slackUser.username || requestBody.current_user_name;
      imageUrl = slackUser.imageUrl;
    }
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
