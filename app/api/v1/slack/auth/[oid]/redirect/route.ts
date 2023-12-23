import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';
import { slackOauthState } from '@/lib/schema';

export const runtime = 'edge'; // 'nodejs' is the default

export async function GET(request: NextRequest) {
  const oid = request.nextUrl.searchParams.get('oid');

  // Check if 'oid' parameter exists
  if (!oid || !isValidUUID(oid)) {
    return new Response(JSON.stringify({ error: 'Missing oid parameter' }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  const state = crypto.randomUUID();

  try {
    await db.insert(slackOauthState).values({
      id: state,
      createdBy: '19e3fc45-fb44-43cb-b72b-1d25087bbb62', // TODO: Get user id from session
      organizationId: oid
    });
  } catch (error) {
    console.log(error);
    return new Response(JSON.stringify({ error: 'Error saving state.' }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  const redirectUrl = `https://slack.com/oauth/v2/authorize?client_id=${process.env.SLACK_CLIENT_ID}&scope=team:read&state=${state}`;
  return NextResponse.redirect(redirectUrl);
}

// Utility function to validate UUID
function isValidUUID(uuid: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    uuid
  );
}
