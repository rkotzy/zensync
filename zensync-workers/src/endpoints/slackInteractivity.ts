import { OpenAPIRoute } from '@cloudflare/itty-router-openapi';
import { initializeDb } from '@/lib/drizzle';
import { eq, and } from 'drizzle-orm';
import {
  verifySlackRequest,
  findSlackConnectionByAppId,
  InteractivityActionId,
  fetchZendeskCredentials
} from '@/lib/utils';
import { SlackConnection, zendeskConnection, channel } from '@/lib/schema';
import * as schema from '@/lib/schema';
import { Logtail } from '@logtail/edge';
import { EdgeWithExecutionContext } from '@logtail/edge/dist/es6/edgeWithExecutionContext';
import { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { ZendeskResponse } from '@/interfaces/zendesk-api.interface';
import { SlackResponse } from '@/interfaces/slack-api.interface';
import { Env } from '@/interfaces/env.interface';
import {
  importEncryptionKeyFromEnvironment,
  encryptData
} from '@/lib/encryption';
import bcrypt from 'bcryptjs';
import Stripe from 'stripe';
import { handleAppHomeOpened } from '@/views/homeTab';
import { responseWithLogging } from '@/lib/logger';
import { getBillingPortalConfiguration } from '@/interfaces/products.interface';
import { initializePosthog } from '@/lib/posthog';

export class SlackInteractivityHandler extends OpenAPIRoute {
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

    // Initialize the encryption key
    const encryptionKey = await importEncryptionKeyFromEnvironment(env);

    // Parse the request body
    const textClone = request.clone();

    // Verify the Slack request
    if (!(await verifySlackRequest(textClone, env))) {
      logger.warn('Slack verification failed!');
      return new Response('Verification failed', { status: 200 });
    }

    const requestBody = await request.formData();
    const payloadString = requestBody.get('payload');

    // Make sure we have a payload
    if (typeof payloadString !== 'string') {
      return new Response('Invalid payload', { status: 400 });
    }

    // Parse the JSON string into an object
    const payload = JSON.parse(payloadString);

    // Find the corresponding organization connection details
    const slackConnectionDetails = await findSlackConnectionByAppId(
      payload.api_app_id,
      db,
      env,
      logger,
      encryptionKey
    );

    if (!slackConnectionDetails) {
      logger.warn(`No organization found for team ID: ${payload.api_app_id}.`);
      return responseWithLogging(
        request,
        payload,
        'Invalid api_app_id',
        404,
        logger
      );
    }

    const actionId = getFirstActionId(payload);

    // Set up the analytics client
    const posthog = initializePosthog(env);
    const analyticsDistinctId = payload.user?.id;
    const analyticsCompanyId = slackConnectionDetails.appId;

    // Handle the edit channel button tap
    if (
      actionId?.startsWith(InteractivityActionId.EDIT_CHANNEL_BUTTON_TAPPED)
    ) {
      try {
        await openChannelConfigurationModal(
          actionId,
          payload,
          slackConnectionDetails,
          db,
          logger
        );
      } catch (error) {
        return returnGenericError(error, logger);
      }
    }
    // Handle the configure zendesk button tap
    else if (
      actionId === InteractivityActionId.CONFIGURE_ZENDESK_BUTTON_TAPPED
    ) {
      try {
        await openZendeskConfigurationModal(
          payload,
          slackConnectionDetails,
          db,
          env,
          encryptionKey,
          logger
        );
      } catch (error) {
        return returnGenericError(error, logger);
      }
    }
    // Handle the configure zendesk modal submission
    else if (
      payload.type === 'view_submission' &&
      payload.view?.callback_id ===
        InteractivityActionId.ZENDESK_CONFIGURATION_MODAL_ID
    ) {
      try {
        await saveZendeskCredentials(
          payload,
          slackConnectionDetails,
          env,
          db,
          encryptionKey,
          logger
        );

        posthog.capture({
          distinctId: analyticsDistinctId,
          event: 'zendesk_connection_saved',
          groups: { company: analyticsCompanyId }
        });

        await posthog.shutdown();
      } catch (error) {
        return returnGenericError(error, logger);
      }
    }

    // Handle the open account settings button tap
    else if (
      actionId === InteractivityActionId.OPEN_ACCOUNT_SETTINGS_BUTTON_TAPPED
    ) {
      try {
        await openAccountSettings(
          payload,
          slackConnectionDetails,
          env,
          logger,
          db
        );

        posthog.capture({
          distinctId: analyticsDistinctId,
          event: 'account_details_viewed',
          groups: { company: analyticsCompanyId }
        });

        await posthog.shutdown();
      } catch (error) {
        return returnGenericError(error, logger);
      }
    }

    // Handle the view_closed event
    else if (payload.type === 'view_closed') {
      const userId = payload.user?.id;
      if (userId) {
        await handleAppHomeOpened(
          userId,
          slackConnectionDetails,
          db,
          env,
          encryptionKey,
          logger
        );
      }
    }

    // The body is intentionally empty here for Slack to close any views
    return responseWithLogging(request, payload, null, 200, logger);
  }
}

function returnGenericError(
  error: any,
  logger: EdgeWithExecutionContext
): Response {
  logger.error(`Error: ${error.message}`);
  return Response.json(
    {
      response_action: 'errors',
      errors: {
        'zendesk-email-input': 'Unable to set up Zendesk connection',
        'zendesk-api-key-input': 'Unable to set up Zendesk connection'
      }
    },
    { status: 200 }
  );
}

function extractZendeskDomain(input: string): string {
  // Regular expression to match the full Zendesk URL pattern and capture the domain prefix
  const urlPattern = /^(?:https?:\/\/)?([^\.]+)\.zendesk\.com$/;
  const match = input.match(urlPattern);

  if (match) {
    // If the input matches the full URL pattern, return the captured domain prefix
    return match[1];
  } else {
    // If the input is not a full URL, assume it's already the domain prefix
    return input;
  }
}

function getFirstActionId(payload: any): string | null {
  // Check if 'actions' exists and is an array
  if (payload && payload.actions && Array.isArray(payload.actions)) {
    // Check if the first element of the array has 'action_id'
    if (payload.actions.length > 0 && payload.actions[0].action_id) {
      return payload.actions[0].action_id;
    }
  }
  // Return null if the structure is not as expected
  return null;
}

async function saveZendeskCredentials(
  payload: any,
  connection: SlackConnection,
  env: Env,
  db: NeonHttpDatabase<typeof schema>,
  key: CryptoKey,
  logger: EdgeWithExecutionContext
): Promise<void> {
  const values = payload.view?.state.values;

  const rawZendeskDomain =
    values?.zendesk_domain['zendesk-domain-input']?.value;
  const rawZendeskAdminEmail =
    values?.zendesk_admin_email['zendesk-email-input']?.value;
  const rawZendeskApiKey =
    values?.zendesk_api_key['zendesk-api-key-input']?.value;

  const zendeskDomain = extractZendeskDomain(
    rawZendeskDomain?.replace(/\s/g, '').toLowerCase()
  );
  const zendeskEmail = rawZendeskAdminEmail?.replace(/\s/g, '').toLowerCase();
  const zendeskKey = rawZendeskApiKey?.replace(/\s/g, '');

  // Base64 encode zendeskEmail/token:zendeskKey
  const zendeskAuthToken = btoa(`${zendeskEmail}/token:${zendeskKey}`);

  // Generate a UUID for the webhook token
  let webhookToken = crypto.randomUUID();

  let zendeskTriggerId: string;
  let zendeskWebhookId: string;
  try {
    // Create a zendesk webhook
    const webhookPayload = JSON.stringify({
      webhook: {
        endpoint: `${env.ROOT_URL}/v1/zendesk/events`,
        http_method: 'POST',
        name: 'Slack-to-Zendesk Sync',
        request_format: 'json',
        status: 'active',
        subscriptions: ['conditional_ticket_events'],
        authentication: {
          type: 'bearer_token',
          data: {
            token: webhookToken
          },
          add_position: 'header'
        }
      }
    });

    const zendeskWebhookResponse = await fetch(
      `https://${zendeskDomain}.zendesk.com/api/v2/webhooks`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${zendeskAuthToken}`
        },
        body: webhookPayload
      }
    );

    if (!zendeskWebhookResponse.ok) {
      // If the response status is not OK, log the status and the response text
      logger.error(
        `Zendesk Webhook API failed with status: ${zendeskWebhookResponse.status}`
      );
      logger.error(`Response: ${await zendeskWebhookResponse.text()}`);
      throw new Error('Failed to set Zendesk webhook');
    }

    // Parse the response body to JSON
    const webhookResponseJson =
      (await zendeskWebhookResponse.json()) as ZendeskResponse;

    zendeskWebhookId = webhookResponseJson.webhook.id;
    if (!zendeskWebhookId) {
      throw new Error('Failed to find webhook id');
    }

    // Create a zendesk trigger to alert the webhook of ticket changes
    const triggerPayload = JSON.stringify({
      trigger: {
        title: 'Zensync - Slack-to-Zendesk Sync [DO NOT EDIT]',
        description:
          'Two-way sync between Slack and Zendesk. Contact your admin or email support@slacktozendesk.com for help.',
        active: true,
        conditions: {
          all: [
            {
              field: 'status',
              operator: 'less_than',
              value: 'closed'
            },
            {
              field: 'role',
              operator: 'is',
              value: 'agent'
            },
            {
              field: 'current_tags',
              operator: 'includes',
              value: 'zensync'
            },
            {
              field: 'current_via_id',
              operator: 'is_not',
              value: '5'
            },
            {
              field: 'comment_is_public',
              operator: 'is',
              value: 'true'
            }
          ]
        },
        actions: [
          {
            field: 'notification_webhook',
            value: [
              zendeskWebhookId,
              '{\n  "ticket_id": "{{ticket.id}}",\n  "external_id": "{{ticket.external_id}}",\n  "last_updated_at": "{{ticket.updated_at_with_timestamp}}",\n  "created_at": "{{ticket.created_at_with_timestamp}}",\n  "requester_email": "{{ticket.requester.email}}",\n  "requester_external_id": "{{ticket.requester.external_id}}",\n  "current_user_email": "{{current_user.email}}",\n  "current_user_name": "{{current_user.name}}",\n  "current_user_external_id": "{{current_user.external_id}}",\n  "message": "{{ticket.latest_public_comment}}",\n  "is_public": "{{ticket.latest_public_comment.is_public}}",\n  "attachments": [\n    {% for attachment in ticket.latest_public_comment.attachments %}\n    {\n      "filename": "{{attachment.filename}}",\n      "url": "{{attachment.url}}"\n    }{% if forloop.last == false %},{% endif %}\n    {% endfor %}\n  ],\n  "via": "{{ticket.via}}"\n}\n'
            ]
          }
        ]
      }
    });

    const zendeskTriggerResponse = await fetch(
      `https://${zendeskDomain}.zendesk.com/api/v2/triggers`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${zendeskAuthToken}`
        },
        body: triggerPayload
      }
    );

    if (!zendeskTriggerResponse.ok) {
      // If the response status is not OK, log the status and the response text
      logger.error(
        `Zendesk Trigger API failed with status: ${zendeskTriggerResponse.status}`
      );
      logger.error(`Response: ${await zendeskTriggerResponse.text()}`);
      throw new Error('Failed to set Zendesk trigger');
    }

    // Parse the response body to JSON
    const triggerResponseJson =
      (await zendeskTriggerResponse.json()) as ZendeskResponse;
    zendeskTriggerId = triggerResponseJson.trigger.id ?? null;
  } catch (error) {
    logger.error(error);
    throw error;
  }

  // If the request is successful, save the credentials to the database
  try {
    const encryptedApiKey = await encryptData(zendeskKey, key);

    const salt = await bcrypt.genSalt(10);
    const hashedWebhookToken = await bcrypt.hash(webhookToken, salt);

    await db
      .insert(zendeskConnection)
      .values({
        encryptedZendeskApiKey: encryptedApiKey,
        zendeskDomain: zendeskDomain,
        zendeskEmail: zendeskEmail,
        slackConnectionId: connection.id,
        status: 'ACTIVE',
        zendeskTriggerId: zendeskTriggerId,
        zendeskWebhookId: zendeskWebhookId,
        hashedWebhookBearerToken: hashedWebhookToken
      })
      .onConflictDoUpdate({
        target: zendeskConnection.slackConnectionId,
        set: {
          updatedAt: new Date(),
          encryptedZendeskApiKey: encryptedApiKey,
          zendeskDomain: zendeskDomain,
          zendeskEmail: zendeskEmail,
          hashedWebhookBearerToken: hashedWebhookToken,
          zendeskTriggerId: zendeskTriggerId,
          zendeskWebhookId: zendeskWebhookId,
          status: 'ACTIVE'
        }
      });

    const slackUserId = payload.user?.id;
    if (slackUserId) {
      await handleAppHomeOpened(slackUserId, connection, db, env, key, logger);
    }
  } catch (error) {
    logger.error(error);
    throw error;
  }
}

async function openSlackModal(
  body: any,
  connection: SlackConnection,
  logger: EdgeWithExecutionContext
) {
  const response = await fetch('https://slack.com/api/views.open', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${connection.token}`
    },
    body: body
  });

  const responseData = (await response.json()) as SlackResponse;

  if (!responseData.ok) {
    logger.error(`Error opening modal: ${body}`);
    throw new Error(`Error opening modal: ${responseData}`);
  }
}

async function openAccountSettings(
  payload: any,
  connection: SlackConnection,
  env: Env,
  logger: EdgeWithExecutionContext,
  db: NeonHttpDatabase<typeof schema>
) {
  const triggerId = payload.trigger_id;

  if (!triggerId) {
    logger.warn('No trigger_id found in payload');
    return;
  }

  try {
    // TODO: - handle this more gracefully on the client
    if (!connection.stripeCustomerId) {
      logger.warn('No stripeCustomerId found in connection');
      throw new Error('No stripe customer found in connection');
    }

    const stripeProductId = connection.subscription?.stripeProductId;
    const stripe = new Stripe(env.STRIPE_API_KEY);

    const limitedChannels = await db
      .select({ id: channel.id })
      .from(channel)
      .where(
        and(
          eq(channel.slackConnectionId, connection.id),
          eq(channel.isMember, true)
        )
      )
      .limit(4);

    const billingPortalConfiguration = getBillingPortalConfiguration(
      limitedChannels.length
    );

    const session: Stripe.BillingPortal.Session =
      await stripe.billingPortal.sessions.create({
        customer: connection.stripeCustomerId,
        ...(billingPortalConfiguration !== null && {
          configuration: billingPortalConfiguration
        }),
        return_url: `https://${connection.domain}.slack.com`
      });

    const portalUrl = session.url;
    if (!portalUrl) {
      logger.warn('No portal URL found');
      throw new Error('No portal URL found');
    }

    let product: Stripe.Product;
    if (stripeProductId) {
      product = await stripe.products.retrieve(
        connection.subscription?.stripeProductId
      );
    }

    const body = JSON.stringify({
      trigger_id: triggerId,
      view: {
        notify_on_close: true,
        type: 'modal',
        title: {
          type: 'plain_text',
          text: 'Account Details',
          emoji: true
        },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Current plan:* ${product?.name ?? ''}`
            }
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `${product?.description ?? ''}`
              }
            ]
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'Manage Subscription',
                  emoji: true
                },
                url: portalUrl
              }
            ]
          }
        ]
      }
    });

    await openSlackModal(body, connection, logger);
  } catch (error) {
    logger.error(`Error in openBillingPortal: ${error}`);
    throw error;
  }
}

async function openZendeskConfigurationModal(
  payload: any,
  connection: SlackConnection,
  db: NeonHttpDatabase<typeof schema>,
  env: Env,
  key: CryptoKey,
  logger: EdgeWithExecutionContext
) {
  const triggerId = payload.trigger_id;

  if (!triggerId) {
    logger.warn('No trigger_id found in payload');
    return;
  }
  try {
    const zendeskInfo = await fetchZendeskCredentials(
      connection.id,
      db,
      env,
      logger,
      key
    );

    const body = JSON.stringify({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        callback_id: InteractivityActionId.ZENDESK_CONFIGURATION_MODAL_ID,
        title: {
          type: 'plain_text',
          text: 'Zendesk Connection',
          emoji: true
        },
        submit: {
          type: 'plain_text',
          text: 'Connect',
          emoji: true
        },
        close: {
          type: 'plain_text',
          text: 'Cancel',
          emoji: true
        },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'Visit our <https://slacktozendesk.com/docs|documentation> for any questions or help connecting to Zendesk.'
            }
          },
          {
            type: 'input',
            block_id: 'zendesk_domain',
            element: {
              type: 'plain_text_input',
              action_id: InteractivityActionId.ZENDESK_DOMAIN_TEXT_FIELD,
              initial_value: `${zendeskInfo?.zendeskDomain ?? ''}`,
              placeholder: {
                type: 'plain_text',
                text: 'slacktozendesk.zendesk.com'
              }
            },
            label: {
              type: 'plain_text',
              text: 'Zendesk Domain Prefix',
              emoji: true
            },
            hint: {
              type: 'plain_text',
              text: 'Example: If your Zendesk domain is yourcompany.zendesk.com, you would just enter "yourcompany" here.'
            }
          },
          {
            type: 'input',
            block_id: 'zendesk_api_key',
            element: {
              type: 'plain_text_input',
              action_id: InteractivityActionId.ZENDESK_API_KEY_TEXT_FIELD,
              placeholder: {
                type: 'plain_text',
                text: '•••••••••••••••••••••••••'
              }
            },
            label: {
              type: 'plain_text',
              text: 'Zendesk API Key',
              emoji: true
            },
            hint: {
              type: 'plain_text',
              text: 'The Zendesk API key your admin created.'
            }
          },
          {
            type: 'input',
            block_id: 'zendesk_admin_email',
            element: {
              type: 'plain_text_input',
              action_id: InteractivityActionId.ZENDESK_EMAIL_TEXT_FIELD,
              initial_value: `${zendeskInfo?.zendeskEmail ?? ''}`,
              placeholder: {
                type: 'plain_text',
                text: 'admin@your-domain.com'
              }
            },
            label: {
              type: 'plain_text',
              text: 'Zendesk Admin Email',
              emoji: true
            },
            hint: {
              type: 'plain_text',
              text: 'Enter the email address of the Zendesk admin that created the API key.'
            }
          }
        ]
      }
    });

    await openSlackModal(body, connection, logger);
  } catch (error) {
    logger.error(`Error in openZendeskConfigurationModal: ${error}`);
    throw error;
  }
}

async function openChannelConfigurationModal(
  actionId: string,
  payload: any,
  connection: SlackConnection,
  db: NeonHttpDatabase<typeof schema>,
  logger: EdgeWithExecutionContext
) {
  const triggerId = payload.trigger_id;
  if (!triggerId) {
    logger.warn('No trigger_id found in payload');
    return;
  }

  try {
    // Parse out the channel ID from the payload
    const channelId = actionId.split(':')[1];
    if (!channelId) {
      logger.warn('No channel ID found in action ID');
      return;
    }

    // Fetch channel info from the database
    const channelInfo = await db.query.channel.findFirst({
      where: and(
        eq(channel.slackConnectionId, connection.id),
        eq(channel.slackChannelIdentifier, channelId)
      )
    });

    if (!channelInfo) {
      logger.warn(`No channel found for ID: ${channelId}`);
      return;
    }

    const activityDate = channelInfo.latestActivityAt;

    const createdAtTimestamp = Math.floor(
      channelInfo.createdAt.getTime() / 1000
    );
    const fallbackText = 'No message activity';

    // Initialize lastActivityString with the fallback text
    let lastActivityString = 'No message activity';

    // Only process latestActivityAt if it is not null
    if (activityDate) {
      const latestActivityTimestamp = Math.floor(activityDate.getTime() / 1000);
      lastActivityString = `Last message on <!date^${latestActivityTimestamp}^{date_short} at {time}|${fallbackText}>`;
    }

    const createdAtString = `Created on <!date^${createdAtTimestamp}^{date_short} at {time}|Created at date unavailable>`;

    const body = JSON.stringify({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        callback_id: `${InteractivityActionId.EDIT_CHANNEL_CONFIGURATION_MODAL_ID}:${channelId}`,
        title: {
          type: 'plain_text',
          text: `#${channelInfo.name}`,
          emoji: true
        },
        submit: {
          type: 'plain_text',
          text: 'Save',
          emoji: true
        },
        close: {
          type: 'plain_text',
          text: 'Cancel',
          emoji: true
        },
        blocks: [
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `${createdAtString}\n${lastActivityString}`
              }
            ]
          },
          {
            type: 'input',
            block_id: 'channel_owner',
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: InteractivityActionId.EDIT_CHANNEL_OWNER_FIELD,
              initial_value: `${channelInfo.defaultAssigneeEmail ?? ''}`,
              placeholder: {
                type: 'plain_text',
                text: 'admin@your-domain.com'
              }
            },
            label: {
              type: 'plain_text',
              text: 'Zendesk Assignee Email',
              emoji: true
            },
            hint: {
              type: 'plain_text',
              text: 'The email address of the Zendesk agent who should be assigned new tickets from this channel. Leave blank to handle assignment in Zendesk.'
            }
          },
          {
            type: 'input',
            block_id: 'channel_tags',
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: InteractivityActionId.EDIT_CHANNEL_TAGS_FIELD,
              initial_value: `${
                channelInfo.tags ? channelInfo.tags.join(', ') : ''
              }`,
              placeholder: {
                type: 'plain_text',
                text: 'enterprise, priority'
              }
            },
            label: {
              type: 'plain_text',
              text: 'Zendesk Tags',
              emoji: true
            },
            hint: {
              type: 'plain_text',
              text: 'Enter a comma separated list of tags to set on Zendesk tickets created from this channel. Tags cannot contain spaces, dashes or special characters (-, #, @, !, etc.). Underscores "_" are allowed. The tag `zensync` is always automatically applied.'
            }
          }
        ]
      }
    });

    await openSlackModal(body, connection, logger);
  } catch (error) {
    logger.error(`Error in openChannelConfigurationModal: ${error}`);
    throw error;
  }
}
