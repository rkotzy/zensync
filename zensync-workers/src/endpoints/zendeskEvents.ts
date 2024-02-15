import { OpenAPIRoute } from '@cloudflare/itty-router-openapi';
import { initializeDb } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import {
  zendeskConnection,
  SlackConnection,
  slackConnection,
  conversation
} from '@/lib/schema';
import * as schema from '@/lib/schema';
import { SlackResponse } from '@/interfaces/slack-api.interface';
import { ZendeskEvent } from '@/interfaces/zendesk-api.interface';
import { Logtail } from '@logtail/edge';
import { EdgeWithExecutionContext } from '@logtail/edge/dist/es6/edgeWithExecutionContext';
import { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { Env } from '@/interfaces/env.interface';
import { getSlackConnection } from '@/lib/utils';
import bcrypt from 'bcryptjs';

export class ZendeskEventHandler extends OpenAPIRoute {
  async handle(
    request: Request,
    env: Env,
    context: any,
    data: Record<string, any>
  ) {
    // Set up logger right away
    const baseLogger = new Logtail(env.BETTER_STACK_SOURCE_TOKEN);
    const logger = baseLogger.withExecutionContext(context);

    // Initialize the database
    const db = initializeDb(env);

    const requestBody = (await request.json()) as ZendeskEvent;
    logger.info(JSON.stringify(requestBody, null, 2));
    // Save some database calls if it's a message from Zensync

    // Ignore messages from Zensync
    if (
      typeof requestBody.current_user_external_id === 'string' &&
      requestBody.current_user_external_id.startsWith('zensync')
    ) {
      logger.info('Message from Zensync, skipping');
      return new Response('Ok', { status: 200 });
    }

    // Make sure we have the last updated ticket time
    const ticketLastUpdatedAt = requestBody.last_updated_at;
    if (!ticketLastUpdatedAt) {
      logger.error('Missing last_updated_at');
      return new Response('Missing last_updated_at', { status: 400 });
    }

    // Ignore messages if last_updated_at === created_at
    // WARNING: - This would ignore messages sent in same minute.
    // Should log in Sentry probably?
    if (requestBody.last_updated_at === requestBody.created_at) {
      logger.info('Message is not an update, skipping');
      return new Response('Ok', { status: 200 });
    }

    // Authenticate the request and get slack connection Id
    const slackConnectionId = await authenticateRequest(request, db, logger);
    if (!slackConnectionId) {
      return new Response('Unauthorized', { status: 401 });
    }

    // Get the conversation from external_id
    const conversationInfo = await db.query.conversation.findFirst({
      where: eq(conversation.id, requestBody.external_id),
      with: {
        channel: true
      }
    });

    if (!conversationInfo?.slackParentMessageId) {
      logger.error(`No conversation found for id ${requestBody.external_id}`);
      return new Response('No conversation found', { status: 404 });
    }

    logger.info(
      `ConversationInfo retrieved: ${JSON.stringify(conversationInfo)}`
    );

    // To be safe I should double-check the organization_id owns the channel_id
    if (
      !conversationInfo.channel ||
      !conversationInfo.channel.slackChannelIdentifier ||
      conversationInfo.channel.slackConnectionId !== slackConnectionId
    ) {
      logger.warn(`Invalid Ids: ${slackConnectionId} !== ${conversationInfo}`);
      return new Response('Invalid Ids', { status: 401 });
    }

    // To be safe I should double-check the organization_id owns the channel_id
    if (
      !conversationInfo.channel ||
      !conversationInfo.channel.slackChannelIdentifier ||
      conversationInfo.channel.slackConnectionId !== slackConnectionId
    ) {
      logger.warn(`Invalid Ids: ${slackConnectionId} !== ${conversationInfo}`);
      return new Response('Invalid Ids', { status: 401 });
    }

    // Get the full slack connection info
    const slackConnectionInfo = await getSlackConnection(
      slackConnectionId,
      db,
      env
    );

    if (!slackConnectionInfo) {
      logger.error(`No Slack connection found for id ${slackConnectionId}`);
      return new Response('No Slack connection found', { status: 404 });
    }

    logger.info(
      `SlackConnectionInfo retrieved: ${JSON.stringify(slackConnectionInfo)}`
    );

    try {
      await sendSlackMessage(
        requestBody,
        slackConnectionInfo,
        conversationInfo.slackParentMessageId,
        conversationInfo.channel.slackChannelIdentifier,
        logger
      );
    } catch (error) {
      logger.error(error);
      return new Response('Error', { status: 500 });
    }

    return new Response('Ok', { status: 202 });
  }
}

async function getSlackUserByEmail(
  connection: SlackConnection,
  email: string,
  logger: EdgeWithExecutionContext
): Promise<{ username: string | undefined; imageUrl: string }> {
  try {
    const response = await fetch(
      `https://slack.com/api/users.lookupByEmail?email=${email}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Bearer ${connection.token}`
        }
      }
    );

    const responseData = (await response.json()) as SlackResponse;

    logger.info(`Slack user response: ${JSON.stringify(responseData)}`);

    if (!responseData.ok) {
      throw new Error(`Error getting Slack user: ${responseData.error}`);
    }

    const username =
      responseData.user.profile?.display_name ||
      responseData.user.profile?.real_name ||
      undefined;
    const imageUrl = responseData.user.profile.image_192;
    return { username, imageUrl };
  } catch (error) {
    logger.error('Error in getSlackUserByEmail:', error);
    throw error;
  }
}

async function authenticateRequest(
  request: Request,
  db: NeonHttpDatabase<typeof schema>,
  logger: EdgeWithExecutionContext
): Promise<string | null> {
  try {
    const authorizationHeader = request.headers.get('authorization');
    const bearerToken = authorizationHeader?.replace('Bearer ', '');

    if (!bearerToken) {
      logger.error('Missing bearer token');
      return null;
    }

    const url = new URL(request.url);
    const publicId = url.searchParams.get('id');

    if (!publicId) {
      logger.error('Missing id');
      return null;
    }

    const connection = await db.query.zendeskConnection.findFirst({
      where: eq(zendeskConnection.webhookPublicId, publicId)
    });

    if (!connection) {
      logger.error('Invalid public Id');
      return null;
    }

    const hashedToken = connection.hashedWebhookBearerToken;
    const isValid = await bcrypt.compare(bearerToken, hashedToken);
    if (!isValid) {
      logger.error('Invalid bearer token');
      return null;
    }

    return connection.slackConnectionId;
  } catch (error) {
    logger.error('Error in authenticateRequest:', error);
    return null;
  }
}

async function sendSlackMessage(
  requestBody: any,
  connection: SlackConnection,
  parentMessageId: string,
  slackChannelId: string,
  logger: EdgeWithExecutionContext
) {
  let username: string | undefined;
  let imageUrl: string | undefined;

  try {
    if (requestBody.current_user_email) {
      const slackUser = await getSlackUserByEmail(
        connection,
        requestBody.current_user_email,
        logger
      );
      username = slackUser.username || requestBody.current_user_name;
      imageUrl = slackUser.imageUrl;
    }
  } catch (error) {
    logger.warn('Error getting Slack user:', error);
  }

  try {
    const body = JSON.stringify({
      channel: slackChannelId,
      text: requestBody.message,
      thread_ts: parentMessageId,
      username: username,
      icon_url: imageUrl
    });

    logger.info(`Sending Slack message: ${body}`);

    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${connection.token}`
      },
      body: body
    });

    logger.info(`Slack response: ${JSON.stringify(response)}`);

    const responseData = (await response.json()) as SlackResponse;

    if (!responseData.ok) {
      throw new Error(`Error posting message: ${responseData.error}`);
    }
  } catch (error) {
    logger.error('Error in sendSlackMessage:', error);
    throw error;
  }

  logger.info('Message posted successfully');
}
