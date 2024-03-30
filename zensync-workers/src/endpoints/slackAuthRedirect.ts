import { OpenAPIRoute } from '@cloudflare/itty-router-openapi';
import { initializeDb } from '@/lib/drizzle';
import { slackOauthState } from '@/lib/schema';
import { Env } from '@/interfaces/env.interface';

export class SlackAuthRedirect extends OpenAPIRoute {
  async handle(
    request: Request,
    env: Env,
    context: any,
    data: Record<string, any>
  ) {
    const state = crypto.randomUUID();

    try {
      const db = initializeDb(env);
      await db.insert(slackOauthState).values({
        id: state
      });
    } catch (error) {
      console.error(error);
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
      env.SLACK_CLIENT_ID
    }&scope=${encodeURIComponent(scopes)}&state=${state}`;
    return Response.redirect(redirectUrl);
  }
}
