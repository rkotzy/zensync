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

  // Create a zendesk webhook subscription
  try {
    const webhookPayload = JSON.stringify({
      webhook: {
        endpoint: 'https://zensync.vercel.app/api/v1/zendesk/messages',
        http_method: 'POST',
        name: 'Slack-to-Zendesk Sync',
        request_format: 'json',
        status: 'active',
        subscriptions: [],
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
    const settingsJson = await zendeskWebhookResponse.json();
    console.log('Zendesk webhook created:', settingsJson);
  } catch (error) {
    console.log(error);
    return NextResponse.json(
      { message: 'Invalid Zendesk Credentials' },
      { status: 400 }
    );
  }

  // If the request is successful, save the credentials to the database
  await db.insert(zendeskConnection).values({
    id: uuid,
    zendeskApiKey: zendeskKey,
    zendeskDomain: zendeskDomain,
    zendeskEmail: zendeskEmail,
    organizationId: '11111111-1111-1111-1111-111111111111' // TODO: Pull this from the user session
  });

  return NextResponse.json({ message: 'Account connected' }, { status: 400 });
}
