import { InteractivityActionId } from '@/lib/utils';
import { SlackConnection } from '@/lib/schema-sqlite';
import * as schema from '@/lib/schema-sqlite';
import { DrizzleD1Database } from 'drizzle-orm/d1';
import { ZendeskResponse } from '@/interfaces/zendesk-api.interface';
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
import { ZendeskConnectionCreate } from '@/interfaces/zendesk-api.interface';
import {
  createOrUpdateZendeskConnection,
  getChannels,
  updateChannelSettings,
  getZendeskCredentials,
  updateDefaultChannelSettings
} from '@/lib/database';
import { openSlackModal } from '@/lib/slack-api';
import {
  createZendeskTrigger,
  getWebhookSigningSecret
} from '@/lib/zendesk-api';
import { openChannelSettings } from '@/views/channelSettingsModal';
import { openChannelConfigurationModal } from '@/views/channelConfigurationModal';

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

    // Parse the JSON string into an object
    const payload = request.bodyJson;

    safeLog('log', 'Payload recieved:', payload);

    // Find the corresponding organization connection details
    const slackConnectionInfo = request.slackConnection;

    const actionId = getFirstActionId(payload);

    // Set up the analytics client
    const posthog = initializePosthog(env);
    const analyticsDistinctId = payload.user?.id;
    const analyticsCompanyId = slackConnectionInfo.slackTeamId;

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

    // Handle the open channel settings button tap
    else if (
      actionId === InteractivityActionId.OPEN_CHANNEL_SETTINGS_BUTTON_TAPPED
    ) {
      try {
        await openChannelSettings(payload, slackConnectionInfo);

        posthog.capture({
          distinctId: analyticsDistinctId,
          event: 'channel_settings_viewed',
          groups: { company: analyticsCompanyId }
        });

        await posthog.shutdown();
      } catch (error) {
        return returnGenericError(error);
      }
    }

    // Handle the configure zendesk modal submission
    else if (
      payload.type === 'view_submission' &&
      payload.view?.callback_id ===
        InteractivityActionId.CHANNEL_SETTINGS_MODAL_ID
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
  let webhookSigningSecret: string;
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

    // Create a zendesk trigger and get the webhook secret in parallel
    [zendeskTriggerId, webhookSigningSecret] = await Promise.all([
      createZendeskTrigger(zendeskAuthToken, zendeskDomain, zendeskWebhookId),
      getWebhookSigningSecret(zendeskAuthToken, zendeskDomain, zendeskWebhookId)
    ]);

    if (!zendeskTriggerId || !webhookSigningSecret) {
      throw new Error('Failed to create trigger or get webhook secret');
    }
  } catch (error) {
    safeLog('error', 'Error saving zendesk credentials', error);
    throw error;
  }

  // If the request is successful, save the credentials to the database
  try {
    const encryptedApiKey = await encryptData(zendeskKey, key);
    const encryptedZendeskSigningSecret = await encryptData(
      webhookSigningSecret,
      key
    );

    const salt = await bcrypt.genSalt(10);
    const hashedWebhookToken = await bcrypt.hash(webhookToken, salt);

    await createOrUpdateZendeskConnection(db, {
      encryptedApiKey,
      zendeskDomain,
      zendeskEmail,
      slackConnectionId: connection.id,
      status: 'ACTIVE',
      zendeskTriggerId,
      zendeskWebhookId,
      encryptedZendeskSigningSecret,
      hashedWebhookToken
    } as ZendeskConnectionCreate);

    const slackUserId = payload.user?.id;
    if (slackUserId) {
      await handleAppHomeOpened(slackUserId, connection, db, env, key);
    }
  } catch (error) {
    safeLog('error', error);
    throw error;
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
    if (!connection.stripeCustomerId) {
      safeLog(
        'error',
        `No stripeCustomerId found in connection ${connection.id}`
      );
      throw new Error('No stripe customer found in connection');
    }

    const stripeProductId = connection.subscription?.stripeProductId;
    const stripe = new Stripe(env.STRIPE_API_KEY);

    const limitedChannels = await getChannels(db, connection.id, 4);

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
    const zendeskInfo = await getZendeskCredentials(
      db,
      env,
      connection.id,
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

  const isGlobal =
    callbackId === InteractivityActionId.CHANNEL_SETTINGS_MODAL_ID;

  try {
    // Parse out the channel ID from the payload
    let channelId: string | undefined;
    if (!isGlobal) {
      channelId = callbackId.split(':')[1];
      if (!channelId) {
        safeLog('error', `No channel ID found in callback_id: ${callbackId}`);
        throw new Error('No channel ID found in callback_id');
      }
    }

    // Extract the state values from the payload
    const ownerFieldActionId = InteractivityActionId.EDIT_CHANNEL_OWNER_FIELD;
    const tagsFieldActionId = InteractivityActionId.EDIT_CHANNEL_TAGS_FIELD;
    const sameSenderActionId =
      InteractivityActionId.SAME_SENDER_IN_TIMEFRAME_FIELD;
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

    // Extract the same sender in timeframe value
    let sameSenderInTimeframeValue: number;
    if (isGlobal) {
      const sameSenderTimeframeBlock = Object.values(stateValues).find(
        block => block[sameSenderActionId]
      );
      if (
        sameSenderTimeframeBlock &&
        typeof sameSenderTimeframeBlock[sameSenderActionId].selected_option
          .value === 'string'
      ) {
        sameSenderInTimeframeValue = parseInt(
          sameSenderTimeframeBlock[sameSenderActionId].selected_option.value
        );
      }
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

    if (!isGlobal) {
      // Update the values in the database
      await updateChannelSettings(
        db,
        connection.id,
        channelId,
        channelOwnerEmail,
        tagsArray
      );
    } else {
      // Update the global settings
      console.log(`Same sender in timeframe: ${sameSenderInTimeframeValue}`);
      await updateDefaultChannelSettings(
        db,
        connection.id,
        channelOwnerEmail,
        tagsArray,
        sameSenderInTimeframeValue
      );
    }

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
