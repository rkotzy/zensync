import { NextResponse, NextRequest } from 'next/server';
import {
  verifySlackRequest,
  findSlackConnectionByTeamId,
  InteractivityActionId
} from '@/lib/utils';
import { SlackConnection } from '@/lib/schema';

export const runtime = 'edge';

export async function POST(request: NextRequest) {
  // Parse the request body
  const textClone = request.clone();

  // Verify the Slack request
  if (!(await verifySlackRequest(textClone))) {
    console.warn('Slack verification failed!');
    return new Response('Verification failed', { status: 200 });
  }

  const requestBody = await request.formData();
  const payloadString = requestBody.get('payload');

  // Make sure we have a payload
  if (typeof payloadString !== 'string') {
    return new NextResponse('Invalid payload', { status: 400 });
  }

  // Parse the JSON string into an object
  const payload = JSON.parse(payloadString);
  console.log(JSON.stringify(payload, null, 2));

  // Find the corresponding organization connection details
  const slackConnectionDetails = await findSlackConnectionByTeamId(
    payload.team?.id
  );

  if (!slackConnectionDetails) {
    console.warn(`No organization found for team ID: ${payload.team?.id}.`);
    return new Response('Invalid team_id', { status: 404 });
  }

  const actionId = getFirstActionId(payload);
  console.log('Action ID:', actionId);

  if (actionId === InteractivityActionId.CONFIGURE_ZENDESK_BUTTON_TAPPED) {
    await openZendeskConfigurationModal(payload, slackConnectionDetails);
  }

  return new NextResponse('Ok', { status: 200 });
}

async function openZendeskConfigurationModal(
  payload: any,
  connection: SlackConnection
) {
  console.log('Opening Zendesk configuration modal');
  const triggerId = payload.trigger_id;

  if (!triggerId) {
    console.warn('No trigger_id found in payload');
    return;
  }

  try {
    const body = JSON.stringify({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        callback_id: 'modal-identifier',
        title: {
          type: 'plain_text',
          text: 'Just a modal'
        },
        blocks: [
          {
            type: 'section',
            block_id: 'section-identifier',
            text: {
              type: 'mrkdwn',
              text: '*Welcome* to ~my~ Block Kit _modal_!'
            },
            accessory: {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Just a button'
              },
              action_id: 'button-identifier'
            }
          }
        ]
      }
    });

    console.log(`Opening Slack modal: ${body}`);

    const response = await fetch('https://slack.com/api/views.open', {
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
      throw new Error(`Error opening modal: ${responseData}`);
    }
  } catch (error) {
    console.error('Error in openZendeskConfigurationModal:', error);
    throw error;
  }
}

function getFirstActionId(payload: any): string | null {
  // Check if 'actions' exists and is an array
  if (payload && payload.actions && Array.isArray(payload.actions)) {
    // Check if the first element of the array has 'action_id'
    if (payload.actions.length > 0 && payload.actions[0].action_id) {
      return payload.actions[0].action_id;
    }
  }
  // Return null if the structure is not as expected
  return null;
}
