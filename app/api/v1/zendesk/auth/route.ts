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

  // Make a test api call to get account settings
  try {
    const zendeskAccountSettings = await fetch(
      `https://${zendeskDomain}.zendesk.com/api/v2/account/settings.json`,
      {
        headers: {
          Authorization: `Basic ${zendeskAuthToken}`
        }
      }
    );
    if (!zendeskAccountSettings.ok) {
      // If the response status is not OK, log the status and the response text
      console.error(
        'Fetch to Zendesk API failed with status:',
        zendeskAccountSettings.status
      );
      console.error('Response:', await zendeskAccountSettings.text());
      throw new Error('Failed to fetch Zendesk account settings');
    }

    // Parse the response body to JSON
    const settingsJson = await zendeskAccountSettings.json();
    console.log('Zendesk account settings:', settingsJson);
  } catch (error) {
    console.log(error);
    return NextResponse.json(
      { message: 'Invalid Zendesk Credentials' },
      { status: 400 }
    );
  }

  // If the request is successful, save the credentials to the database
  await db.insert(zendeskConnection).values({
    zendeskApiKey: zendeskKey,
    zendeskDomain: zendeskDomain,
    zendeskEmail: zendeskEmail,
    organizationId: '11111111-1111-1111-1111-111111111111' // TODO: Pull this from the user session
  });

  return NextResponse.json({ message: 'Account connected' }, { status: 400 });
}
