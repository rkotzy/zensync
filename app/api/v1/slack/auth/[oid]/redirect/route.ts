import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export const runtime = 'edge'; // 'nodejs' is the default

export async function GET(request: NextRequest) {
  const oid = request.nextUrl.searchParams.get('oid');

  // Check if 'oid' parameter exists
  if (!oid) {
    return new Response(JSON.stringify({ error: 'Missing oid parameter' }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  // Check if prisma exists
  if (!prisma) {
    return new Response(JSON.stringify({ error: 'Unknown server error' }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  const state = crypto.randomUUID();

  try {
    await prisma.slackOauthState.create({
      data: {
        id: state,
        createdBy: 'TODO',
        organizationId: oid
      }
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
