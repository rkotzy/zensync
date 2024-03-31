import { OpenAPIRoute } from '@cloudflare/itty-router-openapi';
import { initializeDb } from '@/lib/drizzle';
import { findSlackConnectionByAppId, verifySlackRequest } from '@/lib/utils';
import { SlackConnection } from '@/lib/schema';
import { SlackEvent } from '@/interfaces/slack-api.interface';
import { Env } from '@/interfaces/env.interface';
import { importEncryptionKeyFromEnvironment } from '@/lib/encryption';
import { handleAppHomeOpened } from '@/views/homeTab';
import { isSubscriptionActive, singleEventAnalyticsLogger } from '@/lib/utils';
import { safeLog } from '@/lib/logging';

export class SlackEventHandler extends OpenAPIRoute {
  async handle(
    request: Request,
    env: Env,
    context: any,
    data: Record<string, any>
  ) {
    // Clone the request before consuming since we
    // need is as text and json
    const jsonClone = request.clone();
    const textClone = request.clone();

    // Parse the request body
    const requestBody = (await jsonClone.json()) as SlackEvent;
    safeLog('log', 'Incoming Slack event:', request);

    // Check if this is a URL verification request from Slack
    // if (requestBody.type === 'url_verification') {
    //   // Respond with the challenge value
    //   return new Response(requestBody.challenge, {
    //     status: 200,
    //     headers: {
    //       'Content-Type': 'text/plain'
    //     }
    //   });
    // }

    // Verify the Slack request
    if (!(await verifySlackRequest(textClone, env))) {
      safeLog('warn', 'Slack verification failed!');
      return new Response('Verification failed', {
        status: 200
      });
    }

    ///////////////////////////////////////
    // Handle events that require an organization details
    ///////////////////////////////////////

    const db = initializeDb(env);
    const encryptionKey = await importEncryptionKeyFromEnvironment(env);

    // Find the corresponding slack connection details
    const connectionDetails = await findSlackConnectionByAppId(
      requestBody.api_app_id,
      db,
      env,
      encryptionKey
    );

    if (!connectionDetails) {
      safeLog(
        'warn',
        `No slack connection found for app ID: ${requestBody.api_app_id}.`
      );

      return new Response('Invalid api_app_id', {
        status: 404
      });
    }

    const eventType = requestBody.event?.type;
    const eventSubtype = requestBody.event?.subtype;

    if (eventType === 'app_home_opened') {
      const slackUserId = requestBody.event?.user;

      if (slackUserId) {
        try {
          await handleAppHomeOpened(
            slackUserId,
            connectionDetails,
            db,
            env,
            encryptionKey
          );

          await singleEventAnalyticsLogger(
            slackUserId,
            'app_home_opened',
            connectionDetails.appId,
            null,
            requestBody.event_time,
            null,
            null,
            env,
            null
          );
        } catch (error) {
          safeLog('error', `Error handling app_home_opened: ${error.message}`);
          return new Response('Internal Server Error', {
            status: 500
          });
        }
      } else {
        safeLog('error', 'No slackUserId found in app_home_opened event');
      }
    } else if (
      isSubscriptionActive(connectionDetails, env) &&
      (isMessageToQueue(eventType, eventSubtype) ||
        (eventType === 'message' &&
          isPayloadEligibleForTicket(requestBody, connectionDetails)))
    ) {
      try {
        await env.PROCESS_SLACK_MESSAGES_QUEUE_BINDING.send({
          eventBody: requestBody,
          connectionDetails: connectionDetails
        });
      } catch (error) {
        safeLog('error', `Error publishing message queue: ${error.message}`);
        return new Response('Internal Server Error', {
          status: 500
        });
      }
    } else if (
      eventSubtype === 'file_share' &&
      isSubscriptionActive(connectionDetails, env)
    ) {
      // handle file_share messages differently by processing the file first
      try {
        await env.UPLOAD_FILES_TO_ZENDESK_QUEUE_BINDING.send({
          eventBody: requestBody,
          connectionDetails: connectionDetails
        });
      } catch (error) {
        safeLog('error', `Error publishing file to queue: ${error.message}`);
        return new Response('Internal Server Error', {
          status: 500
        });
      }
    } else if (eventType === 'app_uninstalled') {
      // handle the app being uninstalled from a workspace
      try {
        await env.SLACK_APP_UNINSTALLED_QUEUE_BINDING.send({
          eventBody: requestBody,
          connectionDetails: connectionDetails
        });
      } catch (error) {
        safeLog(
          'error',
          `Error publishing app uninstalled to queue: ${error.message}`
        );
        return new Response('Internal Server Error', {
          status: 500
        });
      }
    } else {
      safeLog('log', 'No processable event type found for event');
    }

    return new Response('Ok', {
      status: 202
    });
  }
}

function isPayloadEligibleForTicket(
  request: any,
  connection: SlackConnection
): boolean {
  const eventData = request.event;

  // Ignore messages from the Zensync itself
  if (connection.botUserId === eventData.user) {
    safeLog('log', 'Ignoring message from Zensync');
    return false;
  }

  // Shouldn't need this if we explicitly check for message subtype
  // for example 'message_changed' is hidden but still needs processing
  // Ignore hidden messages
  // if (eventData.hidden) {
  //   logger.info('Ignoring hidden message');
  //   return false;
  // }

  // Ignore subtypes that are not processable
  // by the message handler
  const eligibleSubtypes = new Set([
    'message_replied',
    'message_changed',
    'message_deleted',
    undefined
  ]);

  const subtype = eventData.subtype;
  if (eligibleSubtypes.has(subtype)) {
    return true;
  }

  safeLog('log', `Ignoring message subtype: ${subtype}`);
  return false;
}

function isMessageToQueue(eventType: string, eventSubtype: string): boolean {
  const specificEventsToHandle = [
    'member_joined_channel',
    'channel_left',
    'channel_archive',
    'channel_unarchive',
    'channel_deleted',
    'channel_rename',
    'channel_id_changed'
  ];
  return (
    specificEventsToHandle.includes(eventType) ||
    specificEventsToHandle.includes(eventSubtype)
  );
}
