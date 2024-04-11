import { eq, and } from 'drizzle-orm';
import { InteractivityActionId, fetchZendeskCredentials } from '@/lib/utils';
import {
  SlackConnection,
  zendeskConnection,
  channel
} from '@/lib/schema-sqlite';
import * as schema from '@/lib/schema-sqlite';
import { DrizzleD1Database } from 'drizzle-orm/d1';
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
import { getBillingPortalConfiguration } from '@/interfaces/products.interface';
import { initializePosthog } from '@/lib/posthog';
import { safeLog } from '@/lib/logging';
import { RequestInterface } from '@/interfaces/request.interface';

export class SlackInteractivityHandler {
  async handle(
    request: RequestInterface,
    env: Env,
    context: any,
    data: Record<string, any>
  ) {
    // Initialize the database
    const db = request.db;

    // Initialize the encryption key
    const encryptionKey = await importEncryptionKeyFromEnvironment(env);

    // Parse the request body
    const textClone = request.clone();

    const requestBody = await request.formData();
    const payloadString = requestBody.get('payload');

    // Make sure we have a payload
    if (typeof payloadString !== 'string') {
      return new Response('Invalid payload', { status: 400 });
    }

    // Parse the JSON string into an object
    const payload = JSON.parse(payloadString);

    safeLog('log', 'Payload recieved:', payload);

    // Find the corresponding organization connection details
    const slackConnectionInfo = request.slackConnection;

    const actionId = getFirstActionId(payload);

    // Set up the analytics client
    const posthog = initializePosthog(env);
    const analyticsDistinctId = payload.user?.id;
    const analyticsCompanyId = slackConnectionInfo.appId;

    // Handle the edit channel button tap
    if (
      actionId?.startsWith(InteractivityActionId.EDIT_CHANNEL_BUTTON_TAPPED)
    ) {
      try {
        await openChannelConfigurationModal(
          actionId,
          payload,
          slackConnectionInfo,
          db
        );
      } catch (error) {
        return returnGenericError(error);
      }
    }
    // Handle the configure zendesk button tap
    else if (
      actionId === InteractivityActionId.CONFIGURE_ZENDESK_BUTTON_TAPPED
    ) {
      try {
        await openZendeskConfigurationModal(
          payload,
          slackConnectionInfo,
          db,
          env,
          encryptionKey
        );
      } catch (error) {
        return returnGenericError(error);
      }
    }
    // Handle the edit channel modal submission
    else if (
      payload.type === 'view_submission' &&
      payload.view?.callback_id.startsWith(
        InteractivityActionId.EDIT_CHANNEL_CONFIGURATION_MODAL_ID
      )
    ) {
      try {
        const response = await updateChannelConfiguration(
          payload,
          slackConnectionInfo,
          db,
          encryptionKey,
          env
        );

        if (response instanceof Response) {
          return response;
        }
      } catch (error) {
        return returnGenericError(error);
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
          slackConnectionInfo,
          env,
          db,
          encryptionKey
        );

        posthog.capture({
          distinctId: analyticsDistinctId,
          event: 'zendesk_connection_saved',
          groups: { company: analyticsCompanyId }
        });

        await posthog.shutdown();
      } catch (error) {
        return returnGenericError(error);
      }
    }

    // Handle the open account settings button tap
    else if (
      actionId === InteractivityActionId.OPEN_ACCOUNT_SETTINGS_BUTTON_TAPPED
    ) {
      try {
        await openAccountSettings(payload, slackConnectionInfo, env, db);

        posthog.capture({
          distinctId: analyticsDistinctId,
          event: 'account_details_viewed',
          groups: { company: analyticsCompanyId }
        });

        await posthog.shutdown();
      } catch (error) {
        return returnGenericError(error);
      }
    }

    // Handle the view_closed event
    else if (payload.type === 'view_closed') {
      const userId = payload.user?.id;
      if (userId) {
        await handleAppHomeOpened(
          userId,
          slackConnectionInfo,
          db,
          env,
          encryptionKey
        );
      }
    }

    // The body is intentionally empty here for Slack to close any views
    return new Response(null, { status: 200 });
  }
}

function returnGenericError(error: any): Response {
  safeLog('error', `Error: ${error.message}`);
  return new Response('There was an issue', { status: 500 });
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
  db: DrizzleD1Database<typeof schema>,
  key: CryptoKey
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
      safeLog(
        'error',
        `Zendesk Webhook API failed with status: ${zendeskWebhookResponse.status}`
      );
      safeLog('error', `Response: ${await zendeskWebhookResponse.text()}`);
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
              operator: 'greater_than',
              value: 'new'
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
              '{\n  "ticket_id": "{{ticket.id}}",\n  "external_id": "{{ticket.external_id}}",\n  "last_updated_at": "{{ticket.updated_at_with_timestamp}}",\n  "created_at": "{{ticket.created_at_with_timestamp}}",\n  "requester_email": "{{ticket.requester.email}}",\n  "requester_external_id": "{{ticket.requester.external_id}}",\n  "current_user_email": "{{current_user.email}}",\n  "current_user_name": "{{current_user.name}}",\n  "current_user_external_id": "{{current_user.external_id}}",\n  "current_user_signature": "{{current_user.signature}}",\n "message": "{{ticket.latest_public_comment}}",\n  "is_public": "{{ticket.latest_public_comment.is_public}}",\n  "attachments": [\n    {% for attachment in ticket.latest_public_comment.attachments %}\n    {\n      "filename": "{{attachment.filename}}",\n      "url": "{{attachment.url}}"\n    }{% if forloop.last == false %},{% endif %}\n    {% endfor %}\n  ],\n  "via": "{{ticket.via}}"\n}\n'
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
      safeLog(
        'error',
        `Zendesk Trigger API failed with status: ${zendeskTriggerResponse.status}`
      );
      safeLog('error', `Response: ${await zendeskTriggerResponse.text()}`);
      throw new Error('Failed to set Zendesk trigger');
    }

    // Parse the response body to JSON
    const triggerResponseJson =
      (await zendeskTriggerResponse.json()) as ZendeskResponse;
    zendeskTriggerId = triggerResponseJson.trigger.id ?? null;
  } catch (error) {
    safeLog('error', error);
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
          updatedAt: new Date().toISOString(),
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
      await handleAppHomeOpened(slackUserId, connection, db, env, key);
    }
  } catch (error) {
    safeLog('error', error);
    throw error;
  }
}

async function openSlackModal(body: any, connection: SlackConnection) {
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
    safeLog('error', 'Error opening modal:', responseData);
    throw new Error(`Error opening modal: ${JSON.stringify(responseData)}`);
  }
}

async function openAccountSettings(
  payload: any,
  connection: SlackConnection,
  env: Env,
  db: DrizzleD1Database<typeof schema>
) {
  const triggerId = payload.trigger_id;

  if (!triggerId) {
    safeLog('warn', 'No trigger_id found in payload');
    return;
  }

  try {
    // TODO: - handle this more gracefully on the client
    if (!connection.stripeCustomerId) {
      safeLog(
        'error',
        `No stripeCustomerId found in connection ${connection.id}`
      );
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
      safeLog('error', 'No portal URL found');
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
          text: 'Subscription Details',
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

    await openSlackModal(body, connection);
  } catch (error) {
    safeLog('error', `Error in openBillingPortal: ${error}`);
    throw error;
  }
}

async function openZendeskConfigurationModal(
  payload: any,
  connection: SlackConnection,
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  key: CryptoKey
) {
  const triggerId = payload.trigger_id;

  if (!triggerId) {
    safeLog('warn', 'No trigger_id found in payload');
    return;
  }
  try {
    const zendeskInfo = await fetchZendeskCredentials(
      connection.id,
      db,
      env,
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
          text: `${zendeskInfo ? 'Update' : 'Connect'}`,
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
              text: 'Visit our <https://slacktozendesk.com/docs/getting-started/connecting-zendesk|documentation> for any questions or help connecting to Zendesk.'
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
              initial_value: `${
                zendeskInfo?.encryptedZendeskApiKey ? '<hidden>' : ''
              }`,
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

    await openSlackModal(body, connection);
  } catch (error) {
    safeLog('error', `Error in openZendeskConfigurationModal: ${error}`);
    throw error;
  }
}

async function openChannelConfigurationModal(
  actionId: string,
  payload: any,
  connection: SlackConnection,
  db: DrizzleD1Database<typeof schema>
) {
  const triggerId = payload.trigger_id;
  if (!triggerId) {
    safeLog('warn', 'No trigger_id found in payload');
    throw new Error('No trigger_id found in payload');
  }

  try {
    // Parse out the channel ID from the payload
    const channelId = actionId.split(':')[1];
    if (!channelId) {
      safeLog('error', 'No channel ID found in action ID');
      throw new Error('No channel ID found in action ID');
    }

    // Fetch channel info from the database
    const channelInfo = await db.query.channel.findFirst({
      where: and(
        eq(channel.slackConnectionId, connection.id),
        eq(channel.slackChannelIdentifier, channelId)
      )
    });

    if (!channelInfo) {
      safeLog('error', `No channel found for ID: ${channelId}`);
      throw new Error(`No channel found for ID: ${channelId}`);
    }

    const activityDate = channelInfo.latestActivityAt;

    const createdAtTimestamp = Math.floor(
      new Date(channelInfo.createdAt).getTime() / 1000
    );
    const fallbackText = 'No message activity';

    // Initialize lastActivityString with the fallback text
    let lastActivityString = 'No message activity';

    // Only process latestActivityAt if it is not null
    if (activityDate) {
      const latestActivityTimestamp = Math.floor(
        new Date(activityDate).getTime() / 1000
      );
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
              type: 'email_text_input',
              action_id: InteractivityActionId.EDIT_CHANNEL_OWNER_FIELD,
              ...(channelInfo.defaultAssigneeEmail
                ? { initial_value: channelInfo.defaultAssigneeEmail }
                : {}),
              placeholder: {
                type: 'plain_text',
                text: 'Enter an email or leave blank'
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
                text: 'example1, example2'
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

    await openSlackModal(body, connection);
  } catch (error) {
    safeLog('error', `Error in openChannelConfigurationModal:`, error);
    throw error;
  }
}

async function updateChannelConfiguration(
  payload: any,
  connection: SlackConnection,
  db: DrizzleD1Database<typeof schema>,
  key: CryptoKey,
  env: Env
) {
  const callbackId = payload.view?.callback_id;
  if (!callbackId) {
    safeLog(
      'error',
      `No callback_id found in payload: ${JSON.stringify(payload)}`
    );
    throw new Error('No callback_id found in payload');
  }

  try {
    // Parse out the channel ID from the payload
    const channelId = callbackId.split(':')[1];
    if (!channelId) {
      safeLog('error', `No channel ID found in callback_id: ${callbackId}`);
      throw new Error('No channel ID found in callback_id');
    }

    // Extract the state values from the payload
    const ownerFieldActionId = InteractivityActionId.EDIT_CHANNEL_OWNER_FIELD;
    const tagsFieldActionId = InteractivityActionId.EDIT_CHANNEL_TAGS_FIELD;
    const stateValues = payload.view.state.values;
    let modalErrors: Record<string, string> = {};

    // Extract and validate the channel owner email
    let channelOwnerEmail: string | undefined;
    const ownerBlock = Object.values(stateValues).find(
      block => block[ownerFieldActionId]
    );
    if (
      ownerBlock &&
      typeof ownerBlock[ownerFieldActionId].value === 'string'
    ) {
      const rawEmail = ownerBlock[ownerFieldActionId].value.trim();

      if (rawEmail.length > 0) {
        // Regular expression for simple email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (emailRegex.test(rawEmail)) {
          channelOwnerEmail = rawEmail;
        } else {
          modalErrors.channel_owner =
            'Please provide a valid email address or leave blank.';
        }
      }
    }

    // Extract the channel tags
    let channelTags: string | undefined;
    const tagsBlock = Object.values(stateValues).find(
      block => block[tagsFieldActionId]
    );
    if (tagsBlock) {
      channelTags = tagsBlock[tagsFieldActionId].value;
    }

    const tagsArray = validateAndConvertTags(channelTags);

    if (tagsArray === null) {
      // Set an error message for the tags field
      modalErrors.channel_tags =
        'Please provide a comma-separated list of tags without spaces or special characters, or leave blank.';
    }

    // See if there are any erros
    if (Object.keys(modalErrors).length > 0) {
      const errorResponse = JSON.stringify({
        response_action: 'errors',
        errors: modalErrors
      });
      return new Response(errorResponse, {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      });
    }

    // Update the values in the database
    await db
      .update(channel)
      .set({
        defaultAssigneeEmail: channelOwnerEmail ?? null,
        tags: tagsArray
      })
      .where(
        and(
          eq(channel.slackConnectionId, connection.id),
          eq(channel.slackChannelIdentifier, channelId)
        )
      );

    // Reload the home view
    const slackUserId = payload.user?.id;
    if (slackUserId) {
      await handleAppHomeOpened(slackUserId, connection, db, env, key);
    }
  } catch (error) {
    safeLog('error', `Error updating channel ${callbackId}`, error);
    throw error;
  }
}

function validateAndConvertTags(
  tagsString: string | undefined | null
): string[] | null {
  // Check for undefined or an empty string
  if (!tagsString || tagsString.trim().length === 0) {
    return []; // No tags provided, return an empty array
  }

  // Trim and remove any extra spaces around commas
  const trimmedTagsString = tagsString.replace(/\s*,\s*/g, ',').trim();

  // Regular expression to match valid tags
  const validTagsRegex = /^[a-zA-Z0-9_]+(,[a-zA-Z0-9_]+)*$/;

  if (validTagsRegex.test(trimmedTagsString)) {
    // Valid format, split into an array by commas
    return trimmedTagsString.split(',');
  } else {
    // Invalid format
    return null;
  }
}
