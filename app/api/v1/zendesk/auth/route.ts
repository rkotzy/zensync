import { NextResponse, NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';

export const runtime = 'edge';

export async function POST(request: NextRequest) {
  const requestBody = await request.json();

  console.log(JSON.stringify(requestBody, null, 2));

  // Stripe all whitespace and lowercase parameters
  const zendeskDomain = requestBody.zendeskDomain
    .replace(/\s/g, '')
    .toLowerCase();
  const zendeskEmail = requestBody.zendeskEmail
    .replace(/\s/g, '')
    .toLowerCase();
  const zendeskKey = requestBody.zendeskKey.replace(/\s/g, '').toLowerCase();

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
    console.log(JSON.stringify(zendeskAccountSettings, null, 2));
  } catch (error) {
    console.log(error);
    return NextResponse.json(
      {
        body: 'Invalid Zendesk Credentials',
        query: request.nextUrl.search,
        cookies: request.cookies.getAll()
      },
      {
        status: 400
      }
    );
  }
  // Your existing logic for other types of requests
  return NextResponse.json(
    {
      body: request.body,
      query: request.nextUrl.search,
      cookies: request.cookies.getAll()
    },
    {
      status: 200
    }
  );
}
