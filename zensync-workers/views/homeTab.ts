import { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { eq, and, desc, is } from 'drizzle-orm';
import { Env } from '@/interfaces/env.interface';
import {
  SlackConnection,
  ZendeskConnection,
  channel,
  Channel
} from '@/lib/schema';
import { SlackResponse } from '@/interfaces/slack-api.interface';
import * as schema from '@/lib/schema';
import { EdgeWithExecutionContext } from '@logtail/edge/dist/es6/edgeWithExecutionContext';
import { fetchZendeskCredentials, InteractivityActionId } from '@/lib/utils';
import { isSubscriptionActive } from '@/lib/utils';

const PENDING_UPGRADE = 'PENDING_UPGRADE';

export async function handleAppHomeOpened(
  slackUserId: string,
  connection: SlackConnection,
  db: NeonHttpDatabase<typeof schema>,
  env: Env,
  key: CryptoKey,
  logger: EdgeWithExecutionContext
) {
  try {
    const [zendeskInfo, channelInfos] = await fetchHomeTabData(
      connection,
      db,
      env,
      key,
      logger
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
        ...buildUpgradeCTA(channelInfos, connection, logger, env),
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'Manage your connection with Zendesk through the button below.'
          }
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text:
                  zendeskInfo?.status !== 'ACTIVE'
                    ? 'Connect to Zendesk'
                    : 'Edit Zendesk Connection',
                emoji: true
              },
              action_id: InteractivityActionId.CONFIGURE_ZENDESK_BUTTON_TAPPED,
              ...(zendeskInfo?.status !== 'ACTIVE' && { style: 'primary' })
            }
          ]
        },
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
        {
          type: 'divider'
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Account Details',
                emoji: true
              },
              action_id:
                InteractivityActionId.OPEN_ACCOUNT_SETTINGS_BUTTON_TAPPED
            }
          ]
        }
      ]
    };

    const body = JSON.stringify({
      user_id: slackUserId,
      view: viewJson
    });

    const response = await fetch('https://slack.com/api/views.publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${connection.token}`
      },
      body: body
    });

    const responseData = (await response.json()) as SlackResponse;

    if (!responseData.ok) {
      logger.info(`Error publishing Slack View: ${body}`);
      const errorDetails = JSON.stringify(responseData, null, 2);
      throw new Error(`Error publishig view: ${errorDetails}`);
    }
  } catch (error) {
    logger.error(`Error in handleAppHomeOpened: ${error.message}`);
    throw error;
  }
}

async function fetchHomeTabData(
  slackConnection: SlackConnection,
  db: NeonHttpDatabase<typeof schema>,
  env: Env,
  key: CryptoKey,
  logger: EdgeWithExecutionContext
): Promise<[ZendeskConnection | null, Channel[]]> {
  try {
    const zendeskInfo = await fetchZendeskCredentials(
      slackConnection.id,
      db,
      env,
      logger,
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
    logger.error(
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

  return channelInfos.flatMap(info => {
    const activityDate = info.latestActivityAt ?? info.createdAt;
    const latestActivityTimestamp = Math.floor(activityDate.getTime() / 1000);
    const fallbackText = activityDate.toLocaleDateString();

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
        text: `*<#${info.slackChannelIdentifier}|${info.name}>*\n*Owner:* ${
          info.defaultAssigneeEmail ?? ''
        }\n*Tags:* ${tagsString}`
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
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Need support? Open your shared slack channel: <#${connection.supportSlackChannelId}|${connection.supportSlackChannelName}>*`
      }
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
  logger: EdgeWithExecutionContext,
  env: Env
): any {
  const subscriptionActive = isSubscriptionActive(connection, logger, env);
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
