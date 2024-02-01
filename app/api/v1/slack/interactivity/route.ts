import { NextResponse, NextRequest } from 'next/server';
import {
  verifySlackRequest,
  findSlackConnectionByTeamId,
  InteractivityActionId,
  fetchZendeskCredentials
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

  const zendeskInfo = await fetchZendeskCredentials(connection.organizationId);

  try {
    const body = JSON.stringify({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        title: {
          type: 'plain_text',
          text: 'Zendesk Connection',
          emoji: true
        },
        submit: {
          type: 'plain_text',
          text: 'Connect',
          emoji: true
        },
        close: {
          type: 'plain_text',
          text: 'Cancel',
          emoji: true
        },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'Visit our <https://slacktozendesk.com/docs|documentation> for any questions or help connecting to Zendesk.'
            }
          },
          {
            type: 'input',
            block_id: 'zendesk_domain',
            element: {
              type: 'plain_text_input',
              action_id: InteractivityActionId.ZENDESK_DOMAIN_TEXT_FIELD,
              initial_value: `${zendeskInfo?.zendeskDomain ?? ''}`,
              placeholder: {
                type: 'plain_text',
                text: 'slacktozendesk.zendesk.com'
              }
            },
            label: {
              type: 'plain_text',
              text: 'Zendesk Domain Prefix',
              emoji: true
            },
            hint: {
              type: 'plain_text',
              text: 'Example: If your Zendesk domain is yourcompany.zendesk.com, you would just enter "yourcompany" here.'
            }
          },
          {
            type: 'input',
            block_id: 'zendesk_admin_email',
            element: {
              type: 'plain_text_input',
              action_id: InteractivityActionId.ZENDESK_EMAIL_TEXT_FIELD,
              initial_value: `${zendeskInfo?.zendeskEmail ?? ''}`,
              placeholder: {
                type: 'plain_text',
                text: 'ryan@slacktozendesk.com'
              }
            },
            label: {
              type: 'plain_text',
              text: 'Zendesk Admin Email',
              emoji: true
            },
            hint: {
              type: 'plain_text',
              text: 'Enter the email address of the Zendesk admin that created the API key.'
            }
          },
          {
            type: 'input',
            block_id: 'zendesk_api_key',
            element: {
              type: 'plain_text_input',
              action_id: InteractivityActionId.ZENDESK_API_KEY_TEXT_FIELD,
              placeholder: {
                type: 'plain_text',
                text: '•••••••••••••••••••••••••'
              }
            },
            label: {
              type: 'plain_text',
              text: 'Zendesk API Key',
              emoji: true
            },
            hint: {
              type: 'plain_text',
              text: 'The Zendesk API key your admin created.'
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
