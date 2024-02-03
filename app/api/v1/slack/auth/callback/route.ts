import type { NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';
import { slackOauthState, slackConnection } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { SlackTeamResponse } from '@/interfaces/slack-api.interface';

export const runtime = 'edge';

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');

  // Check if 'code' and 'state' values exist
  if (!code || !state) {
    return Response.redirect(
      `${process.env.ROOT_URL}/connections?slackOauth=error&message=Missing required parameters: code and state.`
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
    return Response.redirect(
      `${process.env.ROOT_URL}/connections?slackOauth=error&message=Invalid or expired state.`
    );
  }

  let accessToken: string;
  let authedUser: string;
  let botUserId: string;
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

    const responseData = await response.json();

    if (!responseData.ok) {
      return Response.redirect(
        `${process.env.ROOT_URL}/connections?slackOauth=error&message=Failed to authenticate.`
      );
    }

    accessToken = responseData.access_token;
    authedUser = responseData.authed_user.id;
    botUserId = responseData.bot_user_id;

    if (!accessToken || !botUserId) {
      console.log(
        'Error fetching access token or bot user id:',
        JSON.stringify(responseData, null, 2)
      );
      return Response.redirect(
        `${process.env.ROOT_URL}/connections?slackOauth=error&message=Missing access token.`
      );
    }
  } catch (error) {
    console.log(error);
    return Response.redirect(
      `${process.env.ROOT_URL}/connections?slackOauth=error&message=Authentication failed.`
    );
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
          slackTeamId: team.id,
          name: team.name,
          domain: team.domain,
          iconUrl: team.icon.image_132,
          emailDomain: team.email_domain,
          slackEnterpriseId: team.enterprise_id,
          slackEnterpriseName: team.enterprise_name,
          token: accessToken,
          authedUserId: authedUser,
          botUserId: botUserId,
          status: 'ACTIVE'
        })
        .onConflictDoUpdate({
          target: slackConnection.slackTeamId,
          set: {
            name: team.name,
            domain: team.domain,
            iconUrl: team.icon.image_132,
            emailDomain: team.email_domain,
            slackEnterpriseId: team.enterprise_id,
            slackEnterpriseName: team.enterprise_name,
            token: accessToken,
            authedUserId: authedUser,
            botUserId: botUserId,
            status: 'ACTIVE'
          }
        });
    } else {
      console.log('Error fetching team info:', JSON.stringify(json, null, 2));
      return Response.redirect(
        `${process.env.ROOT_URL}/connections?slackOauth=error&message=Invalid access token or permissions.`
      );
    }
  } catch (error) {
    console.error(error);
    return Response.redirect(
      `${process.env.ROOT_URL}/connections?slackOauth=error&message=Error saving access token.`
    );
  }

  return Response.redirect(
    `${process.env.ROOT_URL}/connections?slackOauth=success`
  );
}
