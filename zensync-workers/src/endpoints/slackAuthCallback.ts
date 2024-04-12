import { SlackConnection } from '@/lib/schema-sqlite';
import {
  encryptData,
  decryptData,
  importEncryptionKeyFromEnvironment
} from '@/lib/encryption';
import { Env } from '@/interfaces/env.interface';
import { initializePosthog } from '@/lib/posthog';
import { safeLog } from '@/lib/logging';
import { RequestInterface } from '@/interfaces/request.interface';
import { createOrUpdateSlackConnection } from '@/lib/database';
import { slackOauthResponse, getSlackTeamInfo } from '@/lib/slack-api';
import { SlackTeam } from '@/interfaces/slack-api.interface';
import { responseHtml } from '@/views/slackAuthCallbackHTML';

export class SlackAuthCallback {
  async handle(
    request: RequestInterface,
    env: Env,
    context: any,
    data: Record<string, any>
  ) {
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

    const posthog = initializePosthog(env);
    const db = request.db;
    const encryptionKey = await importEncryptionKeyFromEnvironment(env);

    try {
      // Parse date and connection id from state
      const decryptedState = await decryptData(state, encryptionKey);
      if (!decryptedState || !(await isValidState(decryptedState, env))) {
        return new Response('Invalid or expired auth session. Try again.', {
          status: 401
        });
      }
    } catch (error) {
      safeLog('error', error);
      return new Response('Invalid state.', { status: 401 });
    }

    let accessToken: string;
    let authedUser: string;
    let botUserId: string;
    let appId: string;
    let teamId: string;
    try {
      const responseData = await slackOauthResponse(code, env);

      accessToken = responseData.access_token;
      authedUser = responseData.authed_user.id;
      botUserId = responseData.bot_user_id;
      appId = responseData.app_id;

      if (!accessToken || !botUserId) {
        safeLog(
          'error',
          `Error fetching access token or bot user id: ${JSON.stringify(
            responseData,
            null,
            2
          )}`
        );
        return new Response('Missing access token.', { status: 404 });
      }
    } catch (error) {
      safeLog('error', error);
      return new Response('Authentication failed.', { status: 401 });
    }

    let team: SlackTeam;
    try {
      team = await getSlackTeamInfo(accessToken);
    } catch (error) {
      safeLog('error', error);
      return new Response('Invalid access token.', { status: 401 });
    }

    try {
      // Encrypt the access token before saving to db
      const encryptedToken = await encryptData(accessToken, encryptionKey);

      const connectionInfo = await createOrUpdateSlackConnection(
        db,
        team,
        authedUser,
        botUserId,
        appId,
        encryptedToken
      );

      posthog.groupIdentify({
        distinctId: authedUser,
        groupType: 'company',
        groupKey: team.id,
        properties: {
          name: team.name
        }
      });

      posthog.capture({
        event: 'user_signed_up',
        distinctId: authedUser,
        groups: { company: team.id }
      });

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
      safeLog('error', error);
      return new Response('Error saving Slack access token.', { status: 500 });
    }

    await posthog.shutdown();
    //return Response.redirect(`slack://app?team=${teamId}&id=${appId}&tab=home`);
    return new Response(responseHtml(teamId, appId), {
      status: 200,
      headers: {
        'Content-Type': 'text/html;charset=UTF-8'
      }
    });
  }
}

async function isValidState(state: string, env: Env): Promise<boolean> {
  const [timestamp, slackOauthState] = state.split(':');

  if (!timestamp || !slackOauthState) {
    return false;
  }

  const timestampDate = parseInt(timestamp, 10);
  const now = new Date().getTime();

  if (now - timestampDate > 600000) {
    // 10 minutes validity
    return false;
  }

  if (slackOauthState !== env.SLACK_OAUTH_STATE) {
    return false;
  }

  return true;
}
