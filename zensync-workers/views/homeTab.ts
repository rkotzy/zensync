import { DrizzleD1Database } from 'drizzle-orm/d1';
import { eq, and, desc } from 'drizzle-orm';
import { Env } from '@/interfaces/env.interface';
import {
  SlackConnection,
  ZendeskConnection,
  channel,
  Channel
} from '@/lib/schema-sqlite';
import { SlackResponse } from '@/interfaces/slack-api.interface';
import * as schema from '@/lib/schema-sqlite';
import { InteractivityActionId } from '@/lib/utils';
import { isSubscriptionActive } from '@/lib/utils';
import { safeLog } from '@/lib/logging';
import { getZendeskCredentials } from '@/lib/database';
import { publishView } from '@/lib/slack-api';

const PENDING_UPGRADE = 'PENDING_UPGRADE';

export async function handleAppHomeOpened(
  slackUserId: string,
  connection: SlackConnection,
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  key: CryptoKey
) {
  try {
    const [zendeskInfo, channelInfos] = await fetchHomeTabData(
      connection,
      db,
      env,
      key
    );

    const viewJson = {
      type: 'home',
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: 'Welcome to Zensync :wave:',
            emoji: true
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'Check out our <https://slacktozendesk.com/docs|documentation> for setup guides and answers to common questions.'
          }
        },
        ...buildSupportLinks(connection),
        {
          type: 'divider'
        },
        ...buildUpgradeCTA(channelInfos, connection, env),
        ...connectToZendeskHelper(zendeskInfo),
        {
          type: 'divider'
        },
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: `Connected channels (${channelInfos.length})`,
            emoji: true
          }
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: 'Use command `/invite @zensync` in any channel to connect it with Zendesk.'
            }
          ]
        },
        {
          type: 'divider'
        },
        ...createChannelSections(channelInfos),
        ...buildAccountDetailsSection()
      ]
    };

    const body = JSON.stringify({
      user_id: slackUserId,
      view: viewJson
    });

    // publish view
    await publishView(connection.token, body);
  } catch (error) {
    safeLog('error', `Error in handleAppHomeOpened: ${error.message}`);
    throw error;
  }
}

async function fetchHomeTabData(
  slackConnection: SlackConnection,
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  key: CryptoKey
): Promise<[ZendeskConnection | null, Channel[]]> {
  try {
    const zendeskInfo = await getZendeskCredentials(
      db,
      env,
      slackConnection.id,
      key
    );

    const channelInfos = await db.query.channel.findMany({
      where: and(
        eq(channel.slackConnectionId, slackConnection.id),
        eq(channel.isMember, true)
      ),
      orderBy: [desc(channel.name)],
      limit: 1000 // This is artificaially set just to not blow up the home tab
    });

    return [zendeskInfo, channelInfos];
  } catch (error) {
    safeLog(
      'error',
      `Error fetching home tab data from database: ${error.message}`
    );
    throw error;
  }
}

function containsPendingChannels(channelInfos: Channel[]): boolean {
  return channelInfos.some(channel => channel.status === PENDING_UPGRADE);
}

function createChannelSections(channelInfos) {
  if (channelInfos.length === 0) {
    return [];
  }

  return channelInfos.flatMap((info: Channel) => {
    const activityDate = info.latestActivityAt ?? info.createdAt;
    const latestActivityTimestamp = Math.floor(
      new Date(activityDate).getTime() / 1000
    );
    const fallbackText = new Date(activityDate).toLocaleDateString();

    const slackFormattedDate = `<!date^${latestActivityTimestamp}^{date_short} at {time}|${fallbackText}>`;

    const tags = info.tags || [];
    const tagsString =
      tags.length > 0 ? tags.map(tag => `\`${tag}\``).join(', ') : '';

    // Set accessory button based on the channel's status
    const accessory = {
      type: 'button',
      text: {
        type: 'plain_text',
        emoji: true,
        text: info.status === PENDING_UPGRADE ? ':warning: Upgrade' : 'Edit'
      },
      action_id:
        info.status === PENDING_UPGRADE
          ? InteractivityActionId.OPEN_ACCOUNT_SETTINGS_BUTTON_TAPPED
          : `${InteractivityActionId.EDIT_CHANNEL_BUTTON_TAPPED}:${info.slackChannelIdentifier}`,
      ...(info.status === PENDING_UPGRADE && { style: 'danger' })
    };

    const section = {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*<#${info.slackChannelIdentifier}|${
          info.name
        }>*\n*Zendesk assignee:* ${
          info.defaultAssigneeEmail ?? ''
        }\n*Zendesk tags:* ${tagsString}`
      },
      accessory: accessory
    };

    // Update context text for PENDING_UPGRADE status
    const contextText =
      info.status === PENDING_UPGRADE
        ? 'Channel deactivated, upgrade plan to receive messages!'
        : `Last message on ${slackFormattedDate}`;

    const contextBlock = {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: contextText
        }
      ]
    };

    const dividerBlock = { type: 'divider' };

    return [section, contextBlock, dividerBlock];
  });
}

function buildSupportLinks(connection: SlackConnection): any {
  if (
    !connection.supportSlackChannelId ||
    !connection.supportSlackChannelName
  ) {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Set up your shared slack channel*`
        }
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'Reach out to support@slacktozendesk.com to request a free shared slack channel for help and integration support directly from the Zensync team.'
          }
        ]
      }
    ];
  }

  return [
    {
      type: 'rich_text',
      elements: [
        {
          type: 'rich_text_section',
          elements: [
            {
              type: 'text',
              text: 'Need support? Open your shared slack channel: ',
              style: {
                bold: true
              }
            },
            {
              type: 'channel',
              channel_id: connection.supportSlackChannelId,
              style: {
                bold: true
              }
            }
          ]
        }
      ]
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: "Depending on your Slack permissions, you may need an invite to join.\nIf you can't use Slack, need an invite, or prefer email, reach out to support@slacktozendesk.com."
        }
      ]
    }
  ];
}

function buildUpgradeCTA(
  channelInfos: Channel[],
  connection: SlackConnection,
  env: Env
): any {
  const subscriptionActive = isSubscriptionActive(connection, env);
  const hasPendingChannels = containsPendingChannels(channelInfos);

  if (subscriptionActive && !hasPendingChannels) {
    return [];
  }

  return [
    {
      type: 'section',
      text: {
        type: 'plain_text',
        text: subscriptionActive
          ? ":warning: You've exceeded your plan limit :warning:"
          : ":warning: You're subscription has expired :warning:",
        emoji: true
      }
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Upgrade Plan',
            emoji: true
          },
          action_id: InteractivityActionId.OPEN_ACCOUNT_SETTINGS_BUTTON_TAPPED,
          style: 'danger'
        }
      ]
    },
    {
      type: 'divider'
    }
  ];
}

function connectToZendeskHelper(zendeskInfo: ZendeskConnection): any {
  if (zendeskInfo?.status !== 'ACTIVE') {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Connect Zendesk to start syncing tickets.'
        }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Configure Zendesk',
              emoji: true
            },
            action_id: InteractivityActionId.CONFIGURE_ZENDESK_BUTTON_TAPPED,
            style: 'primary'
          }
        ]
      }
    ];
  }

  return [];
}

function buildAccountDetailsSection(): any {
  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `Account Settings`,
        emoji: true
      }
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Zendesk Connection',
            emoji: true
          },
          action_id: InteractivityActionId.CONFIGURE_ZENDESK_BUTTON_TAPPED
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Subscription Details',
            emoji: true
          },
          action_id: InteractivityActionId.OPEN_ACCOUNT_SETTINGS_BUTTON_TAPPED
        }
      ]
    }
  ];
}

// async function buildZendeskOauthURL(
//   connection: SlackConnection,
//   key: CryptoKey
// ): Promise<string> {
//   const timestamp = new Date().getTime();
//   const state = await encryptData(`${timestamp}:${connection.id}`, key);
//   const encodedState = encodeURIComponent(state);
//   const client_id = 'slacktozendesk';
//   const redirect_uri = encodeURIComponent(
//     'https://api.slacktozendesk.com/v1/zendesk/auth/callback'
//   );
//   const scope = encodeURIComponent(
//     'tickets:read tickets:write users:read users:write webhooks:read webhooks:write triggers:read triggers:write'
//   );

//   const url = `https://d3v-wtf.zendesk.com/oauth/authorizations/new?client_id=${client_id}&response_type=code&redirect_uri=${redirect_uri}&scope=${scope}&state=${encodedState}`;
//   console.log(`Returning URL: ${url}`);

//   return url;
// }
