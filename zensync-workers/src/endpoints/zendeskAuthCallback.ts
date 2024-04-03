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
import {
  encryptData,
  importEncryptionKeyFromEnvironment
} from '@/lib/encryption';
import { Env } from '@/interfaces/env.interface';
import { initializePosthog } from '@/lib/posthog';
import { safeLog } from '@/lib/logging';

export class ZendeskAuthCallback extends OpenAPIRoute {
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
    let teamId: string;
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
        safeLog(
          'error',
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
      teamId = team.id;

      // Encrypt the access token before saving to db
      const encryptionKey = await importEncryptionKeyFromEnvironment(env);
      const encryptedToken = await encryptData(accessToken, encryptionKey);

      const connectionInfo = await db
        .insert(slackConnection)
        .values({
          slackTeamId: teamId,
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

      posthog.groupIdentify({
        distinctId: authedUser,
        groupType: 'company',
        groupKey: teamId,
        properties: {
          name: team.name
        }
      });

      posthog.capture({
        event: 'user_signed_up',
        distinctId: authedUser,
        groups: { company: teamId }
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
      return new Response('Error saving access token.', { status: 500 });
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

function responseHtml(teamId: string, appId: string): string {
  const html = `<!DOCTYPE html>
    <html>
    <head>
        <meta name="viewport" content="width=device-width"/>
        <meta charset="utf-8"/>
        <title data-react-helmet="true"></title>
        <style>
            .button-text { margin-bottom: 6px; font-size: 14px; }
            .icon { margin-right: 6px; }
            .logo-container { width: 240px; margin-right: 0.5rem; }
            .logo-container > svg { fill: #f37f20; }
            .main-text { font-size: 15px; line-height: 1.5rem; }
            .content-container { min-height: 100vh; display: flex; align-items: center; justify-content: center; background-color: #f0f0f2; margin: 0; padding: 0 1rem; font-family: -apple-system, system-ui, BlinkMacSystemFont, "Segoe UI", "Open Sans", "Helvetica Neue", Helvetica, Arial, sans-serif; }
            .card { max-width: 600px; margin: 5rem auto; padding: 2rem; background-color: #fdfdff; border-radius: 6px; box-shadow: 2px 3px 7px 2px rgba(0, 0, 0, 0.02); color: #333; }
        </style>
    </head>
    <body>
    <div id="__flareact">
        <div class="content-container">
            <div class="card">
                <div class="logo-container">
                    <!-- SVG Logo goes here -->
                </div>
                <h2 class="title">You have successfully authorized Zensync 🎉</h2>
                <p class="main-text">You're one step closer to taming your Slack support! Use the links below to dive right in our check out our getting started guides.</p>
                <div class="links-container">
                    <div class="link-item">
                    <span class="icon">🖥️</span>
                        <a href="slack://app?team=${teamId}&id=${appId}&tab=home" target="_blank" rel="noreferrer noopener">Open in Slack</a>
                    </div>
                    <div class="link-item">
                        <span class="icon">📖</span>
                        <a href="https://slacktozendesk.com/docs" target="_blank" rel="noreferrer noopener">Check out the docs and setup guides</a>
                    </div>
                </div>
                <h4 class="closing-remark">Feel free to close this browser window.</h4>
            </div>
        </div>
    </div>
    <!-- Scripts -->
    </body>
    </html>`;
  return html;
}
