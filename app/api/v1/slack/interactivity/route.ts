import { NextResponse, NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';
import {
  verifySlackRequest,
  findSlackConnectionByTeamId,
  InteractivityActionId,
  fetchZendeskCredentials
} from '@/lib/utils';
import { SlackConnection, zendeskConnection } from '@/lib/schema';

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

  // Handle the configure zendesk button tap
  if (actionId === InteractivityActionId.CONFIGURE_ZENDESK_BUTTON_TAPPED) {
    try {
      await openZendeskConfigurationModal(payload, slackConnectionDetails);
    } catch (error) {
      returnGenericError(error);
    }
  }
  // Handle the configure zendesk modal submission
  else if (
    payload.type === 'view_submission' &&
    payload.view?.callback_id ===
      InteractivityActionId.ZENDESK_CONFIGURATION_MODAL_ID
  ) {
    try {
      await saveZendeskCredentials(payload, slackConnectionDetails);
    } catch (error) {
      returnGenericError(error);
    }
  }

  return new NextResponse(null, { status: 200 }); // The body is intentionally empty here for Slack to close any views
}

function returnGenericError(error: any) {
  console.error('Error saving Zendesk credentials:', error);
  return NextResponse.json(
    {
      response_action: 'errors',
      errors: {
        'zendesk-email-input': 'Unable to set up Zendesk connection',
        'zendesk-api-key-input': 'Unable to set up Zendesk connection'
      }
    },
    { status: 200 }
  );
}

async function saveZendeskCredentials(
  payload: any,
  connection: SlackConnection
) {
  const values = payload.view?.state.values;

  const rawZendeskDomain =
    values?.zendesk_domain['zendesk-domain-input']?.value;
  const rawZendeskAdminEmail =
    values?.zendesk_admin_email['zendesk-email-input']?.value;
  const rawZendeskApiKey =
    values?.zendesk_api_key['zendesk-api-key-input']?.value;

  console.log({
    rawZendeskDomain,
    rawZendeskAdminEmail,
    rawZendeskApiKey
  });

  const zendeskDomain = extractZendeskDomain(
    rawZendeskDomain?.replace(/\s/g, '').toLowerCase()
  );
  const zendeskEmail = rawZendeskAdminEmail?.replace(/\s/g, '').toLowerCase();
  const zendeskKey = rawZendeskApiKey?.replace(/\s/g, '');

  console.log({
    zendeskDomain,
    zendeskEmail,
    zendeskKey
  });

  // Base64 encode zendeskEmail/token:zendeskKey
  const zendeskAuthToken = btoa(`${zendeskEmail}/token:${zendeskKey}`);

  // Generate a UUID for the webhook token and database id
  let uuid = crypto.randomUUID();

  let zendeskTriggerId: string;
  let zendeskWebhookId: string;
  try {
    // Create a zendesk webhook
    const webhookPayload = JSON.stringify({
      webhook: {
        endpoint: `${process.env.ROOT_URL}/api/v1/zendesk/events`,
        http_method: 'POST',
        name: 'Slack-to-Zendesk Sync',
        request_format: 'json',
        status: 'active',
        subscriptions: ['conditional_ticket_events'],
        authentication: {
          type: 'bearer_token',
          data: {
            token: uuid
          },
          add_position: 'header'
        }
      }
    });

    const zendeskWebhookResponse = await fetch(
      `https://${zendeskDomain}.zendesk.com/api/v2/webhooks`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${zendeskAuthToken}`
        },
        body: webhookPayload
      }
    );

    if (!zendeskWebhookResponse.ok) {
      // If the response status is not OK, log the status and the response text
      console.error(
        'Zendesk Webhook API failed with status:',
        zendeskWebhookResponse.status
      );
      console.error('Response:', await zendeskWebhookResponse.text());
      throw new Error('Failed to set Zendesk webhook');
    }

    // Parse the response body to JSON
    const webhookResponseJson = await zendeskWebhookResponse.json();
    console.log('Zendesk webhook created:', webhookResponseJson);

    zendeskWebhookId = webhookResponseJson.webhook.id;
    if (!zendeskWebhookId) {
      throw new Error('Failed to find webhook id');
    }

    // Create a zendesk trigger to alert the webhook of ticket changes
    const triggerPayload = JSON.stringify({
      trigger: {
        title: 'Zensync - Slack-to-Zendesk Sync [DO NOT EDIT]',
        description:
          'Two-way sync between Slack and Zendesk. Contact your admin or email support@slacktozendesk.com for help.',
        active: true,
        conditions: {
          all: [
            {
              field: 'status',
              operator: 'less_than',
              value: 'closed'
            },
            {
              field: 'role',
              operator: 'is',
              value: 'agent'
            },
            {
              field: 'current_tags',
              operator: 'includes',
              value: 'zensync'
            },
            {
              field: 'current_via_id',
              operator: 'is_not',
              value: '5'
            },
            {
              field: 'comment_is_public',
              operator: 'is',
              value: 'true'
            }
          ]
        },
        actions: [
          {
            field: 'notification_webhook',
            value: [
              zendeskWebhookId,
              '{\n  "ticket_id": "{{ticket.id}}",\n  "external_id": "{{ticket.external_id}}",\n  "last_updated_at": "{{ticket.updated_at_with_timestamp}}",\n  "created_at": "{{ticket.created_at_with_timestamp}}",\n  "requester_email": "{{ticket.requester.email}}",\n  "requester_external_id": "{{ticket.requester.external_id}}",\n  "current_user_email": "{{current_user.email}}",\n  "current_user_name": "{{current_user.name}}",\n  "current_user_external_id": "{{current_user.external_id}}",\n  "message": "{{ticket.latest_public_comment}}",\n  "is_public": "{{ticket.latest_public_comment.is_public}}",\n  "attachments": [\n    {% for attachment in ticket.latest_public_comment.attachments %}\n    {\n      "filename": "{{attachment.filename}}",\n      "url": "{{attachment.url}}"\n    }{% if forloop.last == false %},{% endif %}\n    {% endfor %}\n  ],\n  "via": "{{ticket.via}}"\n}\n'
            ]
          }
        ]
      }
    });

    const zendeskTriggerResponse = await fetch(
      `https://${zendeskDomain}.zendesk.com/api/v2/triggers`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${zendeskAuthToken}`
        },
        body: triggerPayload
      }
    );

    if (!zendeskTriggerResponse.ok) {
      // If the response status is not OK, log the status and the response text
      console.error(
        'Zendesk Trigger API failed with status:',
        zendeskTriggerResponse.status
      );
      console.error('Response:', await zendeskTriggerResponse.text());
      throw new Error('Failed to set Zendesk trigger');
    }

    // Parse the response body to JSON
    const triggerResponseJson = await zendeskTriggerResponse.json();
    console.log('Zendesk trigger created:', triggerResponseJson);
    zendeskTriggerId = triggerResponseJson.trigger.id ?? null;
  } catch (error) {
    console.log(error);
    return NextResponse.json(
      { message: 'Invalid Zendesk Credentials' },
      { status: 400 }
    );
  }

  // If the request is successful, save the credentials to the database
  await db
    .insert(zendeskConnection)
    .values({
      zendeskApiKey: zendeskKey,
      zendeskDomain: zendeskDomain,
      zendeskEmail: zendeskEmail,
      slackConnectionId: connection.id,
      status: 'ACTIVE',
      zendeskTriggerId: zendeskTriggerId,
      zendeskWebhookId: zendeskWebhookId,
      webhookBearerToken: uuid
    })
    .onConflictDoUpdate({
      target: zendeskConnection.slackConnectionId,
      set: {
        zendeskApiKey: zendeskKey,
        zendeskDomain: zendeskDomain,
        zendeskEmail: zendeskEmail,
        webhookBearerToken: uuid,
        zendeskTriggerId: zendeskTriggerId,
        zendeskWebhookId: zendeskWebhookId,
        status: 'ACTIVE'
      }
    });
}

function extractZendeskDomain(input: string): string {
  // Regular expression to match the full Zendesk URL pattern and capture the domain prefix
  const urlPattern = /^(?:https?:\/\/)?([^\.]+)\.zendesk\.com$/;
  const match = input.match(urlPattern);

  if (match) {
    // If the input matches the full URL pattern, return the captured domain prefix
    return match[1];
  } else {
    // If the input is not a full URL, assume it's already the domain prefix
    return input;
  }
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

  const zendeskInfo = await fetchZendeskCredentials(connection.id);

  try {
    const body = JSON.stringify({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        callback_id: InteractivityActionId.ZENDESK_CONFIGURATION_MODAL_ID,
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
