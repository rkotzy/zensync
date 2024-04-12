import { Env } from '@/interfaces/env.interface';
import { SlackResponse } from '@/interfaces/slack-api.interface';
import { SlackConnection } from './schema-sqlite';
import {
  stripSignatureFromMessage,
  zendeskToSlackMarkdown
} from './message-formatters';
import { safeLog } from '@/lib/logging';
import { singleEventAnalyticsLogger } from './posthog';

export async function sendSlackMessage(
  requestBody: any,
  connection: SlackConnection,
  parentMessageId: string,
  slackChannelId: string,
  env: Env
) {
  let username: string | undefined;
  let imageUrl: string | undefined;

  let slackUser: {
    userId: string;
    username: string;
    imageUrl: string;
  };
  try {
    if (requestBody.current_user_email) {
      slackUser = await getSlackUserByEmail(
        connection,
        requestBody.current_user_email
      );
      username = slackUser.username || requestBody.current_user_name;
      imageUrl = slackUser.imageUrl;
    }
  } catch (error) {
    safeLog('warn', `Error getting Slack user: ${error}`);
  }

  try {
    const message = requestBody.message;
    const signature = requestBody.current_user_signature;
    const strippedMessage = stripSignatureFromMessage(message, signature);
    const formattedMessage = zendeskToSlackMarkdown(strippedMessage);

    const body = JSON.stringify({
      channel: slackChannelId,
      text: formattedMessage,
      thread_ts: parentMessageId,
      username: username,
      icon_url: imageUrl
    });

    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${connection.token}`
      },
      body: body
    });

    const responseData = (await response.json()) as SlackResponse;

    if (!responseData.ok) {
      throw new Error(`Error posting message: ${responseData.error}`);
    }
  } catch (error) {
    safeLog('error', `Error in sendSlackMessage:`, error);
    throw error;
  }

  await singleEventAnalyticsLogger(
    slackUser ? slackUser.userId : 'Zensync',
    'message_reply',
    connection.appId,
    slackChannelId,
    null,
    null,
    {
      source: 'zendesk'
    },
    env,
    null
  );
}

async function getSlackUserByEmail(
  connection: SlackConnection,
  email: string
): Promise<{ userId: string; username: string | undefined; imageUrl: string }> {
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

    const responseData = (await response.json()) as SlackResponse;

    if (!responseData.ok) {
      throw new Error(`Error getting Slack user: ${responseData.error}`);
    }

    const userId = responseData.user.id;
    const username =
      responseData.user.profile?.display_name ||
      responseData.user.profile?.real_name ||
      undefined;
    const imageUrl = responseData.user.profile.image_192;
    return { userId, username, imageUrl };
  } catch (error) {
    safeLog('error', `Error in getSlackUserByEmail:`, error);
    throw error;
  }
}

export async function getSlackUser(
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
    safeLog('error', `Error in getSlackUser:`, error);
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

export async function openSlackModal(body: any, connection: SlackConnection) {
  const response = await fetch('https://slack.com/api/views.open', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${connection.token}`
    },
    body: body
  });

  const responseData = (await response.json()) as SlackResponse;

  if (!responseData.ok) {
    safeLog('error', 'Error opening modal:', responseData);
    throw new Error(`Error opening modal: ${JSON.stringify(responseData)}`);
  }
}

export async function postEphemeralMessage(
  channelId: string,
  userId: string,
  text: string,
  connection: SlackConnection,
  env: Env
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
    safeLog('error', `Failed to post ephemeral message:`, ephemeralResponse);
    // We don't throw here since it's not critical if message isn't sent
  }
}
