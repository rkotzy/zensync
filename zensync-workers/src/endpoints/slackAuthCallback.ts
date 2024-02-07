import {
  OpenAPIRoute,
  OpenAPIRouteSchema,
  Query
} from '@cloudflare/itty-router-openapi';
import { initializeDb } from '@/lib/drizzle';
import { slackOauthState, slackConnection } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { SlackResponse } from '@/interfaces/slack-api.interface';
import { Logtail } from '@logtail/edge';

export interface Env {
  BETTER_STACK_SOURCE_TOKEN: string;
}

export class SlackAuthCallback extends OpenAPIRoute {
  static schema: OpenAPIRouteSchema = {
    parameters: {
      code: Query(String),
      state: Query(String)
    }
  };

  async handle(
    request: Request,
    env: any,
    context: any,
    data: Record<string, any>
  ) {
    // Set up logger right away
    const baseLogger = new Logtail(env.BETTER_STACK_SOURCE_TOKEN);
    const logger = baseLogger.withExecutionContext(context);

    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    // Check if 'code' and 'state' values exist
    if (!code || !state) {
      return new Response(
        'Missing required parameters: code and state. Try again.',
        {
          status: 400
        }
      );
    }

    const db = initializeDb(env);

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
      return new Response('Invalid or expired state. Try again.', {
        status: 401
      });
    }

    let accessToken: string;
    let authedUser: string;
    let botUserId: string;
    try {
      const params = new URLSearchParams();
      params.append('client_id', env.SLACK_CLIENT_ID!);
      params.append('client_secret', env.SLACK_CLIENT_SECRET!);
      params.append('code', code);

      const response = await fetch('https://slack.com/api/oauth.v2.access', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params
      });

      const responseData = (await response.json()) as SlackResponse;

      if (!responseData.ok) {
        return new Response('Failed to authenticate.', { status: 401 });
      }

      accessToken = responseData.access_token;
      authedUser = responseData.authed_user.id;
      botUserId = responseData.bot_user_id;

      if (!accessToken || !botUserId) {
        logger.info(
          `Error fetching access token or bot user id: ${JSON.stringify(
            responseData,
            null,
            2
          )}`
        );
        return new Response('Missing access token.', { status: 404 });
      }
    } catch (error) {
      logger.info(error);
      return new Response('Authentication failed.', { status: 400 });
    }

    logger.info('Access token received');

    const response = await fetch('https://slack.com/api/team.info', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      }
    });

    try {
      const teamInfoResponse = (await response.json()) as SlackResponse;

      if (!teamInfoResponse.ok || !teamInfoResponse.team) {
        logger.info(
          `Error fetching team info: ${JSON.stringify(
            teamInfoResponse,
            null,
            2
          )}`
        );
        return new Response('Invalid access token or permissions.', {
          status: 401
        });
      }

      const team = teamInfoResponse.team;

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
    } catch (error) {
      logger.error(error);
      return new Response('Error saving access token.', { status: 500 });
    }

    return new Response('Success', { status: 200 });
  }
}
