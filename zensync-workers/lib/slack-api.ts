import { Env } from '@/interfaces/env.interface';
import { SlackResponse, SlackTeam } from '@/interfaces/slack-api.interface';
import { SlackConnection } from './schema-sqlite';
import { GlobalSettings } from '@/interfaces/global-settings.interface';
import {
  stripSignatureFromMessage,
  zendeskToSlackMarkdown
} from './message-formatters';
import { safeLog } from '@/lib/logging';
import { singleEventAnalyticsLogger } from './posthog';

export async function slackOauthResponse(
  code: string,
  env: Env
): Promise<SlackResponse> {
  const params = new URLSearchParams();
  params.append('client_id', env.SLACK_CLIENT_ID!);
  params.append('client_secret', env.SLACK_CLIENT_SECRET!);
  params.append('code', code);

  const response = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params
  });

  const responseData = (await response.json()) as SlackResponse;

  if (!responseData.ok) {
    throw new Error(`Failed to authenticate: ${responseData.error}`);
  }

  return responseData;
}

export async function getSlackTeamInfo(
  accessToken: string
): Promise<SlackTeam> {
  const response = await fetch('https://slack.com/api/team.info', {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    }
  });

  const teamInfoResponse = (await response.json()) as SlackResponse;

  if (!teamInfoResponse.ok || !teamInfoResponse.team) {
    throw new Error(`Error fetching team info: ${teamInfoResponse.error}`);
  }

  return teamInfoResponse.team;
}

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
    let message = requestBody.message;
    const signature = requestBody.current_user_signature;

    const glabalSettings: GlobalSettings = connection.globalSettings || {};
    if (glabalSettings.removeZendeskSignatures) {
      message = stripSignatureFromMessage(message, signature);
    }

    const formattedMessage = zendeskToSlackMarkdown(message);

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

export async function getSlackUserEmail(
  userId: string,
  accessToken: string
): Promise<string> {
  const response = await fetch(
    `https://slack.com/api/users.info?user=${userId}`,
    {
      method: 'GET',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  const responseData = (await response.json()) as SlackResponse;

  if (!responseData.ok) {
    throw new Error(`Error getting Slack user email: ${responseData.error}`);
  }

  const email = responseData.user.profile?.email;

  if (!email) {
    throw new Error(`No email in response for Slack user ${userId}`);
  }

  return email;
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

export async function fetchChannelInfo(
  channelId: string,
  accessToken: string
): Promise<SlackResponse> {
  const params = new URLSearchParams();
  params.append('channel', channelId);
  const channelJoinResponse = await fetch(
    `https://slack.com/api/conversations.info?${params.toString()}`,
    {
      method: 'GET',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  const channelJoinResponseData =
    (await channelJoinResponse.json()) as SlackResponse;

  if (!channelJoinResponseData || !channelJoinResponseData.ok) {
    safeLog('error', `Failed to fetch channel info:`, channelJoinResponseData);
    throw new Error('Failed to fetch channel info');
  }

  return channelJoinResponseData;
}

export async function setUpNewSharedSlackChannel(
  env: Env,
  channelSuffix: string
): Promise<string> {
  const headers = {
    'Content-type': 'application/json',
    Accept: 'application/json',
    Authorization: 'Bearer ' + env.INTERNAL_SLACKBOT_ACCESS_TOKEN
  };
  // Step 1: Create Slack channel
  let createChannel = await fetch(
    'https://slack.com/api/conversations.create',
    {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        team_id: 'T06Q45PBVGT', // Zensync team Id
        is_private: false,
        name: `ext-zensync-${channelSuffix}`
      })
    }
  );

  const createChannelResponseData =
    (await createChannel.json()) as SlackResponse;

  if (!createChannelResponseData.ok) {
    throw new Error(
      `Error creating Slack channel: ${createChannelResponseData.error}`
    );
  }
  // Step 2: Invite myself to the channel
  let inviteZensyncAccount = await fetch(
    'https://slack.com/api/conversations.invite',
    {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        channel: createChannelResponseData.channel.id,
        users: 'U06QGUD7F5X' // ryan zensync user id
      })
    }
  );

  const inviteZensyncAccountResponseData =
    (await inviteZensyncAccount.json()) as SlackResponse;

  if (!inviteZensyncAccountResponseData.ok) {
    safeLog(
      'error',
      'Error inviting Zensync Account:',
      inviteZensyncAccountResponseData
    );
    throw new Error(
      `Error inviting Zensync Account: ${inviteZensyncAccountResponseData.error}`
    );
  }

  return createChannelResponseData.channel.id;
}

export async function inviteUserToSharedChannel(
  env: Env,
  channelId: string,
  email: string
) {
  const headers = {
    'Content-type': 'application/json',
    Accept: 'application/json',
    Authorization: 'Bearer ' + env.INTERNAL_SLACKBOT_ACCESS_TOKEN
  };

  let inviteExternalUser = await fetch(
    'https://slack.com/api/conversations.inviteShared',
    {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        channel: channelId,
        emails: email,
        external_limited: false
      })
    }
  );

  const inviteExternalUserResponseData =
    (await inviteExternalUser.json()) as SlackResponse;

  if (!inviteExternalUserResponseData.ok) {
    throw new Error(
      `Error inviting user: ${inviteExternalUserResponseData.error}`
    );
  }
}

export async function getFileInfoFromSlack(
  accessToken: string,
  fileId: string
): Promise<any> {
  try {
    const response = await fetch(
      `https://slack.com/api/files.info?file=${fileId}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    const responseData = (await response.json()) as SlackResponse;

    if (!responseData.ok) {
      safeLog('error', `Error getting Slack file info:`, responseData);
      throw new Error(`Error getting Slack file info: ${responseData.error}`);
    }
    return responseData.file;
  } catch (error) {
    safeLog('error', `Error in getFileInfoFromSlack:`, error);
    throw error;
  }
}

export async function publishView(accessToken: string, body: any) {
  const response = await fetch('https://slack.com/api/views.publish', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    body: body
  });

  const responseData = (await response.json()) as SlackResponse;

  if (!responseData.ok) {
    safeLog('error', `Error publishing Slack View: ${body}`);
    const errorDetails = JSON.stringify(responseData, null, 2);
    throw new Error(`Error publishig view: ${errorDetails}`);
  }
}
