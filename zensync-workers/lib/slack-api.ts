import { Env } from '@/interfaces/env.interface';
import {
  SlackMessageData,
  SlackResponse,
  SlackTeam
} from '@/interfaces/slack-api.interface';
import { SlackConnection, ZendeskConnection } from './schema-sqlite';
import {
  GlobalSettingDefaults,
  GlobalSettings
} from '@/interfaces/global-settings.interface';
import {
  stripSignatureFromMessage,
  zendeskToSlackMarkdown
} from './message-formatters';
import { safeLog } from '@/lib/logging';
import { singleEventAnalyticsLogger } from './posthog';
import Stripe from 'stripe';

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

  const responseJson = await response.json();
  console.log('responseJson', responseJson);

  const responseData = responseJson as SlackResponse;

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
): Promise<{ warningMessage: string } | null> {
  let username: string | undefined;
  let imageUrl: string | undefined;

  let slackUser: {
    userId: string;
    username: string;
    imageUrl: string;
  };
  try {
    if (requestBody.current_user_email) {
      // See if a user in Slack exists with this email
      slackUser = await getSlackUserByEmail(
        connection,
        requestBody.current_user_email
      );

      // If a user exists, use their username and image
      if (slackUser) {
        username = slackUser.username || requestBody.current_user_name;
        imageUrl = slackUser.imageUrl;
      }
    }
  } catch (error) {
    // If an error occurs, log it but don't throw - THIS ISN'T WORKING AND IS THROWING WHEN SHOULDN'T?
    safeLog('warn', `Error getting Slack user: ${error}`);
  }

  try {
    let message = requestBody.message;
    const signature = requestBody.current_user_signature;

    const globalSettings: GlobalSettings = connection.globalSettings || {};

    const {
      removeZendeskSignatures = GlobalSettingDefaults.removeZendeskSignatures
    } = globalSettings;

    if (removeZendeskSignatures) {
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

    if (!responseData.ok && responseData.error) {
      if (responseData.error === 'channel_not_found') {
        safeLog('log', `Channel not found: ${slackChannelId}`);
        return {
          warningMessage:
            "This Slack channel is no longer available for messaging. The channel may have been deleted, or converted to a new Slack Connect channel. Please reply from Slack to continue the conversation - it's safe to close this ticket out"
        };
      } else if (responseData.error === 'is_archived') {
        safeLog('log', `Channel is archived: ${slackChannelId}`);
        return {
          warningMessage:
            "This Slack channel is archived and no longer available for messaging - it's safe to close this ticket out."
        };
      } else if (responseData.error === 'msg_too_long') {
        safeLog('log', `Message is too long`);
        return {
          warningMessage:
            'Your message is too long to be sent to Slack. Try breaking it up into smaller messages.'
        };
      } else if (responseData.error === 'cannot_reply_to_message') {
        safeLog('log', `Cannot reply to message`);
        return {
          warningMessage:
            "This message is ineligible for replies. Please view the message in Slack - it's safe to close this ticket out."
        };
      } else if (responseData.error === 'not_in_channel') {
        safeLog('log', `Bot is no longer in channel: ${slackChannelId}`);
        return {
          warningMessage:
            'The Zensync bot is no longer added to this channel. Please reply from Slack or re-invite @zensync to the channel to continue the conversation.'
        };
      } else {
        throw new Error(`Error posting message: ${responseData.error}`);
      }
    }
  } catch (error) {
    safeLog('error', `Error in sendSlackMessage:`, error);
    throw error;
  }

  await singleEventAnalyticsLogger(
    slackUser ? slackUser.userId : 'Zensync',
    'message_reply',
    connection.slackTeamId,
    slackChannelId,
    null,
    null,
    {
      source: 'zendesk'
    },
    env,
    null
  );

  return null;
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
      return null;
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
    return null;
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
      `https://slack.com/api/users.info?user=${userId}`,
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
      responseData.user.profile.display_name ||
      responseData.user.profile.real_name ||
      undefined;

    const { gravatarUrl, slackUrl } = extractProfileImageUrls(
      responseData.user.profile.image_72
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
): Promise<string | null> {
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
    if (createChannelResponseData.error === 'name_taken') {
      safeLog(
        'error',
        `Channel name ext-zensync-${channelSuffix} already taken`
      );
      return null;
    }
    throw new Error(createChannelResponseData.error);
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

export async function postUpgradeEphemeralMessage(
  channelId: string,
  userId: string,
  connection: SlackConnection,
  env: Env
): Promise<void> {
  // Post a ephemeral message to the user in the channel
  // to inform them that the channel limit has been reached
  let ephemeralMessageText =
    "You've reached your maximum channel limit, upgrade your plan to join this channel.";

  const stripe = new Stripe(env.STRIPE_API_KEY);
  const session: Stripe.BillingPortal.Session =
    await stripe.billingPortal.sessions.create({
      customer: connection.stripeCustomerId,
      return_url: `https://${connection.domain}.slack.com`,
      ...(connection.subscription?.stripeSubscriptionId && {
        flow_data: {
          type: 'subscription_update',
          subscription_update: {
            subscription: connection.subscription.stripeSubscriptionId
          }
        }
      })
    });

  const portalUrl = session.url;
  if (portalUrl) {
    ephemeralMessageText = `You've reached you maximum channel limit, <${portalUrl}|upgrade your plan> to join this channel.`;
  }

  await postEphemeralMessage(
    channelId,
    userId,
    ephemeralMessageText,
    connection,
    env
  );
}
