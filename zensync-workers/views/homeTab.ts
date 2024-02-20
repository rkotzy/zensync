import { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { eq, and, desc } from 'drizzle-orm';
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
          type: 'divider'
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'Manage your connection with Zendesk through the button below. Refer to our <https://slacktozendesk.com/docs|docs> for more information.'
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

function createChannelSections(channelInfos: Channel[]) {
  // If the channelInfos array is empty, return an empty array
  if (channelInfos.length === 0) {
    return [];
  }

  // Map over the channelInfos array to create a section for each item
  return channelInfos
    .map(info => {
      const activityDate = info.latestActivityAt ?? info.createdAt;
      const latestActivityTimestamp = Math.floor(activityDate.getTime() / 1000);
      const fallbackText = activityDate.toLocaleDateString(); // Simplified fallback text generation

      const slackFormattedDate = `<!date^${latestActivityTimestamp}^{date_short} at {time}|${fallbackText}>`;

      const tags = info.tags || [];
      const tagsString =
        tags.length > 0 ? tags.map(tag => `\`${tag}\``).join(', ') : '';

      return [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*<#${info.slackChannelIdentifier}|${info.name}>*\n*Owner:* ${
              info.defaultAssigneeEmail ?? ''
            }\n*Tags:* ${tagsString}`
          },
          accessory: {
            type: 'button',
            text: {
              type: 'plain_text',
              emoji: true,
              text: 'Edit'
            },
            action_id: `${InteractivityActionId.EDIT_CHANNEL_BUTTON_TAPPED}:${info.slackChannelIdentifier}`
          }
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Last message on ${slackFormattedDate}`
            }
          ]
        },
        {
          type: 'divider'
        }
      ];
    })
    .flat();
}
