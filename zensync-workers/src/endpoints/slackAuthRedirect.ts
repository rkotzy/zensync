import { OpenAPIRoute } from '@cloudflare/itty-router-openapi';
import { initializeDb } from '@/lib/drizzle';
import { slackOauthState } from '@/lib/schema';
import { Logtail } from '@logtail/edge';

export interface Env {
  BETTER_STACK_SOURCE_TOKEN: string;
}

export class SlackAuthRedirect extends OpenAPIRoute {
  async handle(
    request: Request,
    env: any,
    context: any,
    data: Record<string, any>
  ) {
    // Set up logger right away
    const baseLogger = new Logtail(env.BETTER_STACK_SOURCE_TOKEN);
    const logger = baseLogger.withExecutionContext(context);

    const state = crypto.randomUUID();

    try {
      const db = initializeDb(env);
      await db.insert(slackOauthState).values({
        id: state
      });
    } catch (error) {
      logger.log(error);
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
    return Response.redirect(redirectUrl);
  }
}
