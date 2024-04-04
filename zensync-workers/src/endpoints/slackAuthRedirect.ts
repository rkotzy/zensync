import { OpenAPIRoute } from '@cloudflare/itty-router-openapi';
import { Env } from '@/interfaces/env.interface';
import {
  encryptData,
  importEncryptionKeyFromEnvironment
} from '@/lib/encryption';
import { safeLog } from '@/lib/logging';

export class SlackAuthRedirect extends OpenAPIRoute {
  async handle(
    request: Request,
    env: Env,
    context: any,
    data: Record<string, any>
  ) {
    let state: string;
    try {
      const timestamp = new Date().getTime();
      const key = await importEncryptionKeyFromEnvironment(env);
      state = await encryptData(`${timestamp}:${env.SLACK_OAUTH_STATE}`, key);
    } catch (error) {
      safeLog('error', error);
      return new Response(JSON.stringify({ error: 'Error setting state.' }), {
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
