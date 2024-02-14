import { OpenAPIRoute } from '@cloudflare/itty-router-openapi';
import { initializeDb } from '@/lib/drizzle';
import { eq, and, desc } from 'drizzle-orm';
import {
  fetchZendeskCredentials,
  findSlackConnectionByTeamId,
  InteractivityActionId,
  verifySlackRequest
} from '@/lib/utils';
import {
  SlackConnection,
  ZendeskConnection,
  Channel,
  channel
} from '@/lib/schema';
import * as schema from '@/lib/schema';
import { Logtail } from '@logtail/edge';
import { EdgeWithExecutionContext } from '@logtail/edge/dist/es6/edgeWithExecutionContext';
import { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { SlackEvent, SlackResponse } from '@/interfaces/slack-api.interface';
import { Env } from '@/interfaces/env.interface';
import { importEncryptionKeyFromEnvironment } from '@/lib/encryption';

export class SlackEventHandler extends OpenAPIRoute {
  async handle(
    request: Request,
    env: Env,
    context: any,
    data: Record<string, any>
  ) {
    // Set up logger right away
    const baseLogger = new Logtail(env.BETTER_STACK_SOURCE_TOKEN);
    const logger = baseLogger.withExecutionContext(context);

    // Clone the request before consuming since we
    // need is as text and json
    const jsonClone = request.clone();
    const textClone = request.clone();

    // Parse the request body
    const requestBody = (await jsonClone.json()) as SlackEvent;
    logger.info(JSON.stringify(requestBody, null, 2));

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

    // Verify the Slack request
    if (!(await verifySlackRequest(textClone, env))) {
      logger.warn('Slack verification failed!');
      return new Response('Verification failed', { status: 200 });
    }

    ///////////////////////////////////////
    // Handle events that require an organization details
    ///////////////////////////////////////

    const db = initializeDb(env);
    const encryptionKey = await importEncryptionKeyFromEnvironment(env);

    // Find the corresponding slack connection details
    const connectionDetails = await findSlackConnectionByTeamId(
      requestBody.team_id,
      db,
      env,
      encryptionKey
    );

    if (!connectionDetails) {
      logger.warn(
        `No slack connection found for team ID: ${requestBody.team_id}.`
      );
      return new Response('Invalid team_id', { status: 404 });
    }

    const eventType = requestBody.event?.type;
    const eventSubtype = requestBody.event?.subtype;

    if (eventType === 'app_home_opened') {
      logger.info(`Handling app_home_opened event`);
      try {
        await handleAppHomeOpened(
          requestBody,
          connectionDetails,
          db,
          env,
          encryptionKey,
          logger
        );
      } catch (error) {
        logger.error(`Error handling app_home_opened: ${error.message}`);
        return new Response('Internal Server Error', { status: 500 });
      }
    } else if (
      isMessageToQueue(eventType, eventSubtype) ||
      (eventType === 'message' &&
        isPayloadEligibleForTicket(requestBody, connectionDetails, logger))
    ) {
      logger.info(`Publishing event ${eventType}:${eventSubtype} to queue`);
      try {
        await env.PROCESS_SLACK_MESSAGES_QUEUE_BINDING.send({
          eventBody: requestBody,
          connectionDetails: connectionDetails
        });
      } catch (error) {
        logger.error(`Error publishing message queue: ${error.message}`);
        return new Response('Internal Server Error', { status: 500 });
      }
    } else if (eventSubtype === 'file_share') {
      // handle file_share messages differently by processing the file first
      logger.info(`Publishing event ${eventType}:${eventSubtype} to queue`);
      try {
        await env.UPLOAD_FILES_TO_ZENDESK_QUEUE_BINDING.send({
          eventBody: requestBody,
          connectionDetails: connectionDetails
        });
      } catch (error) {
        logger.error(`Error publishing file to queue: ${error.message}`);
        return new Response('Internal Server Error', { status: 500 });
      }
    } else {
      logger.info(
        `No processable event type found for event: ${JSON.stringify(
          requestBody.event,
          null,
          2
        )}`
      );
    }

    return new Response('Ok', { status: 202 });
  }
}

function isPayloadEligibleForTicket(
  request: any,
  connection: SlackConnection,
  logger: EdgeWithExecutionContext
): boolean {
  const eventData = request.event;

  // Ignore messages from the Zensync itself
  if (connection.botUserId === eventData.user) {
    logger.info('Ignoring message from Zensync');
    return false;
  }

  // Shouldn't need this if we explicitly check for message subtype
  // for example 'message_changed' is hidden but still needs processing
  // Ignore hidden messages
  // if (eventData.hidden) {
  //   logger.info('Ignoring hidden message');
  //   return false;
  // }

  // Ignore subtypes that are not processable
  // by the message handler
  const eligibleSubtypes = new Set([
    'message_replied',
    'message_changed',
    'message_deleted',
    undefined
  ]);

  const subtype = eventData.subtype;
  if (eligibleSubtypes.has(subtype)) {
    return true;
  }

  logger.info(`Ignoring message subtype: ${subtype}`);
  return false;
}

function isMessageToQueue(eventType: string, eventSubtype: string): boolean {
  const specificEventsToHandle = [
    'member_joined_channel',
    'channel_left',
    'channel_archive',
    'channel_unarchive',
    'channel_deleted',
    'channel_rename',
    'channel_id_changed'
  ];
  return (
    specificEventsToHandle.includes(eventType) ||
    specificEventsToHandle.includes(eventSubtype)
  );
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

async function handleAppHomeOpened(
  requestBody: any,
  connection: SlackConnection,
  db: NeonHttpDatabase<typeof schema>,
  env: Env,
  key: CryptoKey,
  logger: EdgeWithExecutionContext
) {
  const slackUserId = requestBody.event?.user;

  if (!slackUserId) {
    logger.error('No user found in event body');
    return;
  }

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
        ...createChannelSections(channelInfos)
      ]
    };

    const body = JSON.stringify({
      user_id: slackUserId,
      view: viewJson
    });

    logger.info(`Publishing Slack View: ${body}`);

    const response = await fetch('https://slack.com/api/views.publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${connection.token}`
      },
      body: body
    });

    logger.info(`Slack response: ${JSON.stringify(response)}`);

    const responseData = (await response.json()) as SlackResponse;

    if (!responseData.ok) {
      const errorDetails = JSON.stringify(responseData, null, 2);
      throw new Error(`Error publishig view: ${errorDetails}`);
    }
  } catch (error) {
    logger.error(`Error in handleAppHomeOpened: ${error.message}`);
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
