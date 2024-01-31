import { NextResponse, NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import {
  zendeskConnection,
  channel,
  ZendeskConnection,
  SlackConnection,
  Channel
} from '@/lib/schema';
import { verifySignatureEdge } from '@upstash/qstash/dist/nextjs';

export const runtime = 'edge';

const eventHandlers: Record<
  string,
  (body: any, connection: SlackConnection) => Promise<void>
> = {
  app_home_opened: handleAppHomeOpened
};

export const POST = verifySignatureEdge(handler);
async function handler(request: NextRequest) {
  const requestJson = await request.json();
  let responseJson = requestJson;
  console.log(JSON.stringify(requestJson, null, 2));

  const requestBody = requestJson.eventBody;
  const connectionDetails = requestJson.connectionDetails;
  if (!connectionDetails) {
    console.error('No connection details found');
    return new NextResponse('No connection details found.', { status: 500 });
  }

  const eventType = requestBody.event?.type;
  const eventSubtype = requestBody.event?.subtype;

  if (eventSubtype && eventHandlers[eventSubtype]) {
    try {
      await eventHandlers[eventSubtype](requestBody, connectionDetails);
    } catch (error) {
      console.error(`Error handling ${eventSubtype} subtype event:`, error);
      return new NextResponse('Internal Server Error', { status: 500 });
    }
  } else if (eventType && eventHandlers[eventType]) {
    try {
      await eventHandlers[eventType](requestBody, connectionDetails);
    } catch (error) {
      console.error(`Error handling ${eventType} event:`, error);
      return new NextResponse('Internal Server Error', { status: 500 });
    }
  } else {
    console.warn(`No handler for event type: ${eventType}`);
  }

  return new NextResponse('Ok', { status: 200 });
}

async function fetchHomeTabData(
  slackConnection: SlackConnection
): Promise<[ZendeskConnection | undefined, Channel[]]> {
  try {
    const zendeskInfo = await db.query.zendeskConnection.findFirst({
      where: eq(
        zendeskConnection.organizationId,
        slackConnection.organizationId
      )
    });

    const channelInfos = await db.query.channel.findMany({
      where: eq(channel.organizationId, slackConnection.organizationId)
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

    const body = JSON.stringify({
      user_id: slackUserId,
      view: {
        type: 'home',
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: 'Welcome to Zensync 👋'
            }
          },
          {
            type: 'divider'
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Zendesk Connection*'
            },
            accessory: {
              type: 'button',
              text: {
                type: 'plain_text',
                text: zendeskInfo?.status === 'ACTIVE' ? 'Edit' : 'Connect',
                emoji: true
              },
              style: zendeskInfo?.status === 'ACTIVE' ? null : 'primary',
              action_id: 'configure-zendesk',
              value: 'configure-zendesk'
            }
          }
        ]
      }
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
      throw new Error(`Error publishig view: ${responseData.error}`);
    }
  } catch (error) {
    console.error('Error in handleAppHomeOpened:', error);
    throw error;
  }
}
