import { NextResponse, NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';
import { zendeskConnection } from '@/lib/schema';

export const runtime = 'edge';

export async function POST(request: NextRequest) {
  const requestBody = await request.json();

  // Stripe all whitespace and lowercase parameters
  const zendeskDomain = requestBody.zendeskDomain
    .replace(/\s/g, '')
    .toLowerCase();
  const zendeskEmail = requestBody.zendeskEmail
    .replace(/\s/g, '')
    .toLowerCase();
  const zendeskKey = requestBody.zendeskKey.replace(/\s/g, '');

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
      id: uuid,
      zendeskApiKey: zendeskKey,
      zendeskDomain: zendeskDomain,
      zendeskEmail: zendeskEmail,
      organizationId: '11111111-1111-1111-1111-111111111111', // TODO: Pull this from the user session
      status: 'ACTIVE',
      zendeskTriggerId: zendeskTriggerId,
      zendeskWebhookId: zendeskWebhookId
    })
    .onConflictDoUpdate({
      target: zendeskConnection.organizationId,
      set: {
        zendeskApiKey: zendeskKey,
        zendeskDomain: zendeskDomain,
        zendeskEmail: zendeskEmail,
        status: 'ACTIVE'
      }
    });

  return NextResponse.json({ message: 'Account connected' }, { status: 200 });
}
