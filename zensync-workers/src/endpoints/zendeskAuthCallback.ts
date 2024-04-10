import {
  OpenAPIRoute,
  OpenAPIRouteSchema,
  Query
} from '@cloudflare/itty-router-openapi';
import { slackConnection } from '@/lib/schema-sqlite';
import { eq } from 'drizzle-orm';
import {
  decryptData,
  importEncryptionKeyFromEnvironment
} from '@/lib/encryption';
import { Env } from '@/interfaces/env.interface';
import { initializePosthog } from '@/lib/posthog';
import { safeLog } from '@/lib/logging';
import { ZendeskResponse } from '@/interfaces/zendesk-api.interface';
import { RequestInterface } from '@/interfaces/request.interface';

export class ZendeskAuthCallback {
  async handle(
    request: RequestInterface,
    env: Env,
    context: any,
    data: Record<string, any>
  ) {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');

    // Check if there is an error
    if (error) {
      return new Response(`Error: ${error}. Description: ${errorDescription}`, {
        status: 400
      });
    }

    // Check if 'code' and 'state' values exist
    if (!code || !state) {
      return new Response(
        'Missing required parameters: code and state. Try again.',
        {
          status: 400
        }
      );
    }

    const posthog = initializePosthog(env);
    const db = request.db;
    const encryptionKey = await importEncryptionKeyFromEnvironment(env);

    // Parse date and connection id from state
    const decryptedState = await decryptData(state, encryptionKey);
    const [timestamp, connectionIdString] = decryptedState.split(':');
    const connectionId = parseInt(connectionIdString);

    if (!timestamp || !connectionId) {
      return new Response('Invalid state. Try again.', { status: 401 });
    }

    const timestampDate = parseInt(timestamp, 10);
    const now = new Date().getTime();

    if (now - timestampDate > 600000) {
      // 10 minutes validity
      return new Response('Authentication session has expired. Try again.', {
        status: 401
      });
    }

    try {
      // Get connection from database
      const connection = await db.query.slackConnection.findFirst({
        where: eq(slackConnection.id, connectionId)
      });

      if (!connection) {
        safeLog('error', `Slack Connection ${connectionId} not found.`);
        return new Response('Slack connection not found.', { status: 404 });
      }

      // Fetch access token from Zendesk
      const payload = {
        grant_type: 'authorization_code',
        code,
        client_id: 'slacktozendesk',
        client_secret: env.ZENDESK_OAUTH_SECRET!,
        redirect_uri: `${env.ROOT_URL}/v1/zendesk/auth/callback`,
        scope:
          'tickets:read tickets:write users:read users:write webhooks:read webhooks:write triggers:read triggers:write'
      };

      const response = await fetch('https://d3v-wtf.zendesk.com/oauth/tokens', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error('Failed to authenticate with Zendesk.');
      }

      const responseData = (await response.json()) as ZendeskResponse;

      if (!responseData.access_token) {
        throw new Error('No access token found.');
      }

      // // Encrypt Zendesk access token before saving to db
      // const encryptedAccessToken = await encryptData(
      //   responseData.access_token,
      //   encryptionKey
      // );

      // await db
      //   .insert(zendeskConnection)
      //   .values({
      //     encryptedZendeskApiKey: encryptedApiKey,
      //     encryptedToken: encryptedAccessToken,
      //     zendeskDomain: zendeskDomain,
      //     zendeskEmail: zendeskEmail,
      //     slackConnectionId: connection.id,
      //     status: 'ACTIVE',
      //     zendeskTriggerId: zendeskTriggerId,
      //     zendeskWebhookId: zendeskWebhookId,
      //     hashedWebhookBearerToken: hashedWebhookToken
      //   })
      //   .onConflictDoUpdate({
      //     target: zendeskConnection.slackConnectionId,
      //     set: {
      //       updatedAt: new Date(),
      //       encryptedZendeskApiKey: encryptedApiKey,
      //       zendeskDomain: zendeskDomain,
      //       zendeskEmail: zendeskEmail,
      //       hashedWebhookBearerToken: hashedWebhookToken,
      //       zendeskTriggerId: zendeskTriggerId,
      //       zendeskWebhookId: zendeskWebhookId,
      //       status: 'ACTIVE'
      //     }
      //   });

      // TODO: Reload the Home tab

      // Send user back to the slack app
      return Response.redirect(
        `slack://app?team=${connection.slackTeamId}&id=${connection.appId}&tab=home`
      );
    } catch (error) {
      safeLog('error', error);
      return new Response('Error saving Zendesk access token.', {
        status: 500
      });
    }
  }
}
