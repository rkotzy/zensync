import { NextResponse, NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';
import { eq, is } from 'drizzle-orm';
import {
  SlackConnection,
  ZendeskConnection,
  Channel,
  channel
} from '@/lib/schema';
import { Client } from '@upstash/qstash';
import {
  fetchZendeskCredentials,
  findSlackConnectionByTeamId,
  InteractivityActionId,
  verifySlackRequest
} from '@/lib/utils';

export const runtime = 'edge';

export async function POST(request: NextRequest) {
  // Clone the request before consuming since we
  // need is as text and json
  const jsonClone = request.clone();
  const textClone = request.clone();

  // Parse the request body
  const requestBody = await jsonClone.json();
  console.log(JSON.stringify(requestBody, null, 2));

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
  if (!(await verifySlackRequest(textClone))) {
    console.warn('Slack verification failed!');
    return new Response('Verification failed', { status: 200 });
  }

  ///////////////////////////////////////
  // Handle events that require an organization details
  ///////////////////////////////////////

  // Find the corresponding organization connection details
  const connectionDetails = await findSlackConnectionByTeamId(
    requestBody.team_id
  );

  if (!connectionDetails) {
    console.warn(`No organization found for team ID: ${requestBody.team_id}.`);
    return new Response('Invalid team_id', { status: 404 });
  }

  const eventType = requestBody.event?.type;
  const eventSubtype = requestBody.event?.subtype;

  if (eventType === 'app_home_opened') {
    console.log(`Handling app_home_opened event`);
    try {
      await handleAppHomeOpened(requestBody, connectionDetails);
    } catch (error) {
      console.error('Error handling app_home_opened:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  } else if (
    isMessageToQueue(eventType, eventSubtype) ||
    (eventType === 'message' &&
      isPayloadEligibleForTicket(requestBody, connectionDetails))
  ) {
    console.log(`Publishing event ${eventType}:${eventSubtype} to qstash`);
    try {
      const qstash = new Client({ token: process.env.QSTASH_TOKEN! });
      await qstash.publishJSON({
        url: `${process.env.ROOT_URL}/api/v1/slack/worker/messages`,
        body: { eventBody: requestBody, connectionDetails: connectionDetails },
        contentBasedDeduplication: true
      });
    } catch (error) {
      console.error('Error publishing message qstash:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  } else if (eventSubtype === 'file_share') {
    // handle file_share messages differently by processing the file first
    console.log(`Publishing event ${eventType}:${eventSubtype} to qstash`);
    try {
      const qstash = new Client({ token: process.env.QSTASH_TOKEN! });
      await qstash.publishJSON({
        url: `${process.env.ROOT_URL}/api/v1/slack/worker/files`,
        body: { eventBody: requestBody, connectionDetails: connectionDetails },
        contentBasedDeduplication: true,
        retries: 1,
        failureCallback: `${process.env.ROOT_URL}/api/v1/slack/worker/messages`
      });
    } catch (error) {
      console.error('Error publishing file to qstash:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  } else {
    console.log(
      `No processable event type found for event: ${JSON.stringify(
        requestBody.event,
        null,
        2
      )}`
    );
  }

  return new NextResponse('Ok', { status: 202 });
}

function isPayloadEligibleForTicket(
  request: any,
  connection: SlackConnection
): boolean {
  const eventData = request.event;

  // Ignore messages from the Zensync itself
  if (connection.botUserId === eventData.user) {
    console.log('Ignoring message from Zensync');
    return false;
  }

  // Shouldn't need this if we explicitly check for message subtype
  // for example 'message_changed' is hidden but still needs processing
  // Ignore hidden messages
  // if (eventData.hidden) {
  //   console.log('Ignoring hidden message');
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

  console.log(`Ignoring message subtype: ${subtype}`);
  return false;
}

function isMessageToQueue(eventType: string, eventSubtype: string): boolean {
  const specificEventsToHandle = ['member_joined_channel', 'channel_left'];
  return (
    specificEventsToHandle.includes(eventType) ||
    specificEventsToHandle.includes(eventSubtype)
  );
}

async function fetchHomeTabData(
  slackConnection: SlackConnection
): Promise<[ZendeskConnection | null, Channel[]]> {
  try {
    const zendeskInfo = await fetchZendeskCredentials(
      slackConnection.organizationId
    );

    const channelInfos = await db.query.channel.findMany({
      where: eq(channel.organizationId, slackConnection.organizationId),
      limit: 1000 // This is artificaially set just to not blow up the home tab
    });

    return [zendeskInfo, channelInfos];
  } catch (error) {
    console.error('Error fetching home tab data from database:', error);
    throw error;
  }
}

async function handleAppHomeOpened(
  requestBody: any,
  connection: SlackConnection
) {
  const slackUserId = requestBody.event?.user;

  if (!slackUserId) {
    console.error('No user found in event body');
    return;
  }

  try {
    const [zendeskInfo, channelInfos] = await fetchHomeTabData(connection);

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
              text: 'Use command `/invite @zensync` any channel to connect it with Zendesk.'
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

    console.log(`Publishing Slack View: ${body}`);

    const response = await fetch('https://slack.com/api/views.publish', {
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
      throw new Error(`Error publishig view: ${responseData}`);
    }
  } catch (error) {
    console.error('Error in handleAppHomeOpened:', error);
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
      return [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*<fakeLink.toHotelPage.com|#${info.name}>*\nOwner: ${info.defaultAssigneeEmail}\nTags: \`enterprise\``
          },
          accessory: {
            type: 'button',
            text: {
              type: 'plain_text',
              emoji: true,
              text: 'Edit'
            }
          }
        },
        {
          type: 'context',
          elements: [
            {
              type: 'plain_text',
              emoji: true,
              text: `Last active on ${info.latestActivityAt ?? info.createdAt}`
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
