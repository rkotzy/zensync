import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import prisma from '@/lib/prisma';
import { SlackTeamResponse } from '@/interfaces/slack-api.interface';

export const runtime = 'edge'; // 'nodejs' is the default

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');

  // Check if 'code' and 'state' values exist
  if (!code || !state) {
    return new Response(
      JSON.stringify({ error: 'Missing required parameters: code and state.' }),
      {
        status: 400,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
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

  const slackOauthState = await prisma.slackOauthState.findUnique({
    where: {
      id: state
    }
  });

  // Check if state exists and is not expired
  if (
    !slackOauthState ||
    new Date().getTime() - new Date(slackOauthState.createdAt).getTime() >
      600000 // 10 minutes validity
  ) {
    return new Response(
      JSON.stringify({ error: 'Invalid or expired state.' }),
      {
        status: 400,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
  }

  console.log(`Authenticated org ID: ${slackOauthState.organizationId}`);

  let accessToken: string;
  try {
    const response = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        client_id: process.env.SLACK_CLIENT_ID,
        client_secret: process.env.SLACK_CLIENT_SECRET,
        code
      })
    });

    if (!response.ok) {
      return new Response(JSON.stringify({ error: 'Failed to authenticate' }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }

    const responseData = await response.json();
    accessToken = responseData.access_token;
  } catch (error) {
    console.log(error);
    return new Response(JSON.stringify({ error: 'Authentication failed' }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  console.log('Access token received');

  const response = await fetch('https://slack.com/api/team.info', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    }
  });

  const json = await response.json();
  if ('ok' in json && json.ok && 'team' in json && json.team) {
    const teamInfoResponse: SlackTeamResponse = json as SlackTeamResponse;

    try {
      const team = teamInfoResponse.team!;
      await prisma.slackConnections.upsert({
        where: {
          organizationId: slackOauthState.organizationId
        },
        update: {
          slackTeamId: team.id,
          name: team.name,
          domain: team.domain,
          iconUrl: team.icon.image,
          emailDomain: team.email_domain,
          slackEnterpriseId: team.enterprise_id,
          slackEnterpriseName: team.enterprise_name,
          token: accessToken
        },
        create: {
          organizationId: slackOauthState.organizationId,
          slackTeamId: team.id,
          name: team.name,
          domain: team.domain,
          iconUrl: team.icon.image,
          emailDomain: team.email_domain,
          slackEnterpriseId: team.enterprise_id,
          slackEnterpriseName: team.enterprise_name,
          token: accessToken
        }
      });
    } catch (error) {
      console.error(error);
      return new Response(
        JSON.stringify({ error: 'Error saving access token.' }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );
    }
  } else {
    console.log(`Error fetching team info: ${response.json()}`);
    return new Response(
      JSON.stringify({ error: 'Invalid access token or permissions.' }),
      {
        status: 400,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
  }

  return NextResponse.json({ message: 'Authentication Successful' });
}
