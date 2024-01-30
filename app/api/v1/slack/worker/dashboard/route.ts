import { NextResponse, NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import {
  zendeskConnection,
  ZendeskConnection,
  SlackConnection
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
    const body = JSON.stringify({
      user_id: slackUserId,
      view: {
        type: 'home',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'This is a Block Kit example'
            },
            accessory: {
              type: 'image',
              image_url:
                'https://api.slack.com/img/blocks/bkb_template_images/notifications.png',
              alt_text: 'calendar thumbnail'
            }
          }
        ]
      }
    });

    console.log(`Publishing Slack View: ${body}`);

    const response = await fetch('https://slack.com/api/view.publish', {
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
