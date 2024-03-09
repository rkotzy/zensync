import {
  OpenAPIRoute,
  OpenAPIRouteSchema,
  Query
} from '@cloudflare/itty-router-openapi';
import { initializeDb } from '@/lib/drizzle';
import {
  slackOauthState,
  slackConnection,
  SlackConnection
} from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { SlackResponse } from '@/interfaces/slack-api.interface';
import { Logtail } from '@logtail/edge';
import {
  encryptData,
  importEncryptionKeyFromEnvironment
} from '@/lib/encryption';
import { Env } from '@/interfaces/env.interface';

export class SlackAuthCallback extends OpenAPIRoute {
  static schema: OpenAPIRouteSchema = {
    parameters: {
      code: Query(String),
      state: Query(String)
    }
  };

  async handle(
    request: Request,
    env: Env,
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
    let appId: string;
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
      appId = responseData.app_id;

      if (!accessToken || !botUserId) {
        logger.error(
          `Error fetching access token or bot user id: ${JSON.stringify(
            responseData,
            null,
            2
          )}`
        );
        return new Response('Missing access token.', { status: 404 });
      }
    } catch (error) {
      logger.error(error);
      return new Response('Authentication failed.', { status: 400 });
    }

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
        logger.error(
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

      // Encrypt the access token before saving to db
      const encryptionKey = await importEncryptionKeyFromEnvironment(env);
      const encryptedToken = await encryptData(accessToken, encryptionKey);

      const connectionInfo = await db
        .insert(slackConnection)
        .values({
          slackTeamId: team.id,
          name: team.name,
          domain: team.domain,
          iconUrl: team.icon.image_132,
          emailDomain: team.email_domain,
          slackEnterpriseId: team.enterprise_id,
          slackEnterpriseName: team.enterprise_name,
          encryptedToken: encryptedToken,
          authedUserId: authedUser,
          botUserId: botUserId,
          appId: appId,
          status: 'ACTIVE'
        })
        .onConflictDoUpdate({
          target: slackConnection.slackTeamId,
          set: {
            updatedAt: new Date(),
            name: team.name,
            domain: team.domain,
            iconUrl: team.icon.image_132,
            emailDomain: team.email_domain,
            slackEnterpriseId: team.enterprise_id,
            slackEnterpriseName: team.enterprise_name,
            encryptedToken: encryptedToken,
            authedUserId: authedUser,
            botUserId: botUserId,
            appId: appId,
            status: 'ACTIVE'
          }
        })
        .returning();

      // Send to a customer created queue to create a Stripe account
      if (connectionInfo && connectionInfo.length === 1) {
        const fullConnectionInfo: SlackConnection = {
          ...connectionInfo[0],
          token: accessToken
        };

        // Only send to queue if the connection created not updated
        if (!fullConnectionInfo.updatedAt) {
          await env.SLACK_CONNECTION_CREATED_QUEUE_BINDING.send({
            connectionDetails: fullConnectionInfo,
            idempotencyKey: crypto.randomUUID()
          });
        }
      }
    } catch (error) {
      logger.error(error);
      return new Response('Error saving access token.', { status: 500 });
    }

    return new Response('Success', { status: 200 });
  }
}
