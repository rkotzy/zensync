import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';
import { slackOauthState, slackConnection } from '@/lib/schema';
import { eq } from 'drizzle-orm';
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

  const slackOauthStateResponse = await db.query.slackOauthState.findFirst({
    where: eq(slackOauthState.id, state)
  });

  // Check if state exists and is not expired
  if (
    !slackOauthStateResponse ||
    new Date().getTime() -
      new Date(slackOauthStateResponse.createdAt).getTime() >
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

  console.log(
    `Authenticated org ID: ${slackOauthStateResponse.organizationId}`
  );

  let accessToken: string;
  let authedUser: string;
  try {
    const params = new URLSearchParams();
    params.append('client_id', process.env.SLACK_CLIENT_ID!);
    params.append('client_secret', process.env.SLACK_CLIENT_SECRET!);
    params.append('code', code);

    const response = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params
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
    authedUser = responseData.authed_user.id;

    if (!accessToken) {
      console.log(
        'Error fetching access token:',
        JSON.stringify(responseData, null, 2)
      );
      return new Response(JSON.stringify({ error: 'Missing access token' }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
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
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    }
  });

  try {
    const json = await response.json();
    if ('ok' in json && json.ok && 'team' in json && json.team) {
      const teamInfoResponse: SlackTeamResponse = json as SlackTeamResponse;

      const team = teamInfoResponse.team!;

      await db
        .insert(slackConnection)
        .values({
          organizationId: slackOauthStateResponse.organizationId,
          slackTeamId: team.id,
          name: team.name,
          domain: team.domain,
          iconUrl: team.icon.image_132,
          emailDomain: team.email_domain,
          slackEnterpriseId: team.enterprise_id,
          slackEnterpriseName: team.enterprise_name,
          token: accessToken,
          slackUserId: authedUser,
          status: 'ACTIVE'
        })
        .onConflictDoUpdate({
          target: slackConnection.organizationId,
          set: {
            slackTeamId: team.id,
            name: team.name,
            domain: team.domain,
            iconUrl: team.icon.image_132,
            emailDomain: team.email_domain,
            slackEnterpriseId: team.enterprise_id,
            slackEnterpriseName: team.enterprise_name,
            token: accessToken,
            slackUserId: authedUser,
            status: 'ACTIVE'
          }
        });
    } else {
      console.log('Error fetching team info:', JSON.stringify(json, null, 2));

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

  return NextResponse.json({ message: 'Authentication Successful' });
}
