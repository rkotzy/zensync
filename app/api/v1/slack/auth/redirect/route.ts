import { NextResponse, NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';
import { slackOauthState } from '@/lib/schema';

export const runtime = 'edge';

export async function GET(request: NextRequest) {
  const state = crypto.randomUUID();

  try {
    await db.insert(slackOauthState).values({
      id: state
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
    'users:read',
    'users.profile:read',
    'files:read',
    'files:write'
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
