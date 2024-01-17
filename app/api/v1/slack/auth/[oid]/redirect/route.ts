import { NextResponse, NextRequest } from 'next/server';
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

  // TODO: Verify user is a member of the organization

  try {
    await db.insert(slackOauthState).values({
      id: state,
      createdBy: '00000000-0000-0000-0000-000000000000', // TODO: Get user id from session
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
  const scopes = [
    'team:read',
    'channels:read',
    'groups:read',
    'channels:history',
    'groups:history',
    'reactions:read',
    'chat:write',
    'chat:write.customize',
    'users:read.email',
    'users:read'
  ].join(',');

  const redirectUrl = `https://slack.com/oauth/v2/authorize?client_id=${
    process.env.SLACK_CLIENT_ID
  }&scope=${encodeURIComponent(scopes)}&state=${state}`;
  return NextResponse.redirect(redirectUrl);
}

// Utility function to validate UUID (general format for postgres)
function isValidUUID(uuid: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    uuid
  );
}
