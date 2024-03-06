import { eq, and } from 'drizzle-orm';
import {
  zendeskConnection,
  ZendeskConnection,
  slackConnection,
  SlackConnection,
  channel
} from '@/lib/schema';
import * as schema from '@/lib/schema';
import { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { EdgeWithExecutionContext } from '@logtail/edge/dist/es6/edgeWithExecutionContext';
import { Env } from '@/interfaces/env.interface';
import { decryptData, importEncryptionKeyFromEnvironment } from './encryption';
import Stripe from 'stripe';

export enum InteractivityActionId {
  // Zendesk modal details
  CONFIGURE_ZENDESK_BUTTON_TAPPED = 'configure-zendesk',
  ZENDESK_CONFIGURATION_MODAL_ID = 'zendesk-configuration-modal',
  ZENDESK_DOMAIN_TEXT_FIELD = 'zendesk-domain-input',
  ZENDESK_EMAIL_TEXT_FIELD = 'zendesk-email-input',
  ZENDESK_API_KEY_TEXT_FIELD = 'zendesk-api-key-input',

  // Edit channel modal details
  EDIT_CHANNEL_BUTTON_TAPPED = 'edit-channel',
  EDIT_CHANNEL_CONFIGURATION_MODAL_ID = 'edit-channel-configuration-modal',
  EDIT_CHANNEL_OWNER_FIELD = 'edit-channel-owner-input',
  EDIT_CHANNEL_TAGS_FIELD = 'edit-channel-tags-input',

  // Account settings modal details
  OPEN_ACCOUNT_SETTINGS_BUTTON_TAPPED = 'open-account-settings',

  // Get help modal details
  GET_HELP_BUTTON_TAPPED = 'get-help'
}

export async function verifySlackRequest(
  request: Request,
  env: Env
): Promise<boolean> {
  const signingSecret = env.SLACK_SIGNING_SECRET;
  const timestamp = request.headers.get('x-slack-request-timestamp');
  const slackSignature = request.headers.get('x-slack-signature');
  const body = await request.text();

  const basestring = `v0:${timestamp}:${body}`;

  // Convert the Slack signing secret and the basestring to Uint8Array
  const encoder = new TextEncoder();
  const keyData = encoder.encode(signingSecret);
  const data = encoder.encode(basestring);

  // Import the signing secret key for use with HMAC
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  // Create HMAC and get the signature as hex string
  const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, data);
  const mySignature = Array.from(new Uint8Array(signatureBuffer))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');

  const computedSignature = `v0=${mySignature}`;

  // Compare the computed signature and the Slack signature
  return timingSafeEqual(computedSignature, slackSignature || '');
}

// Timing-safe string comparison used in verifySlackRequest
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return mismatch === 0;
}

export async function fetchZendeskCredentials(
  slackConnectionId: string,
  db: NeonHttpDatabase<typeof schema>,
  env: Env,
  logger: EdgeWithExecutionContext,
  key?: CryptoKey
): Promise<ZendeskConnection | null | undefined> {
  try {
    const zendeskCredentials = await db.query.zendeskConnection.findFirst({
      where: eq(zendeskConnection.slackConnectionId, slackConnectionId)
    });
    const zendeskDomain = zendeskCredentials?.zendeskDomain;
    const zendeskEmail = zendeskCredentials?.zendeskEmail;
    const encryptedZendeskApiKey = zendeskCredentials?.encryptedZendeskApiKey;

    if (!zendeskDomain || !zendeskEmail || !encryptedZendeskApiKey) {
      logger.error(
        `No Zendesk credentials found for slack connection ${slackConnectionId}`
      );
      return null;
    }

    let encryptionKey = key;
    if (!encryptionKey) {
      encryptionKey = await importEncryptionKeyFromEnvironment(env);
    }
    const decryptedApiKey = await decryptData(
      encryptedZendeskApiKey,
      encryptionKey
    );

    return {
      ...zendeskCredentials,
      zendeskApiKey: decryptedApiKey
    };
  } catch (error) {
    logger.error(`Error querying ZendeskConnections: ${error}`);
    return undefined;
  }
}

export async function findSlackConnectionByTeamId(
  teamId: string | undefined,
  db: NeonHttpDatabase<typeof schema>,
  env: Env,
  logger: EdgeWithExecutionContext,
  key?: CryptoKey
): Promise<SlackConnection | null | undefined> {
  if (!teamId) {
    logger.error('No team_id found');
    return undefined;
  }

  try {
    const connection = await db.query.slackConnection.findFirst({
      where: eq(slackConnection.slackTeamId, teamId),
      with: {
        subscription: true
      }
    });

    if (connection) {
      let encryptionKey = key;
      if (!encryptionKey) {
        encryptionKey = await importEncryptionKeyFromEnvironment(env);
      }
      const decryptedToken = await decryptData(
        connection.encryptedToken,
        encryptionKey
      );

      return { ...connection, token: decryptedToken };
    }

    return null;
  } catch (error) {
    logger.error(`Error querying SlackConnections: ${error}`);
    return undefined;
  }
}

export async function getSlackConnection(
  connectionId: string,
  db: NeonHttpDatabase<typeof schema>,
  env: Env,
  logger: EdgeWithExecutionContext,
  key?: CryptoKey
): Promise<SlackConnection | null | undefined> {
  try {
    const connection = await db.query.slackConnection.findFirst({
      where: eq(slackConnection.id, connectionId)
    });

    if (connection) {
      let encryptionKey = key;
      if (!encryptionKey) {
        encryptionKey = await importEncryptionKeyFromEnvironment(env);
      }
      const decryptedToken = await decryptData(
        connection.encryptedToken,
        encryptionKey
      );

      return { ...connection, token: decryptedToken };
    }

    return null;
  } catch (error) {
    logger.error(`Error finding SlackConnection: ${error}`);
    return undefined;
  }
}

export async function updateChannelActivity(
  slackConnection: SlackConnection,
  channelId: string,
  db: NeonHttpDatabase<typeof schema>,
  logger: EdgeWithExecutionContext
): Promise<void> {
  const now = new Date();

  await db
    .update(channel)
    .set({
      updatedAt: now,
      latestActivityAt: now
    })
    .where(
      and(
        eq(channel.slackConnectionId, slackConnection.id),
        eq(channel.slackChannelIdentifier, channelId)
      )
    );
}

export async function createStripeAccount(
  name: string,
  email: string | undefined,
  env: Env,
  idempotencyKey: string,
  logger: EdgeWithExecutionContext
): Promise<{
  customerId: string;
  subscriptionId: string;
  currentPeriodEnd: number;
  currentPeriodStart: number;
}> {
  try {
    const stripe = new Stripe(env.STRIPE_API_KEY);

    const customer: Stripe.Customer = await stripe.customers.create(
      {
        name: name,
        ...(email ? { email: email } : {})
      },
      { idempotencyKey: `customer-${idempotencyKey}` }
    );

    const subscription: Stripe.Subscription = await stripe.subscriptions.create(
      {
        customer: customer.id,
        items: [{ price: 'price_1OjpyEDlJlwKmwDWreiHLSAY' }] // Default free plan
      },
      { idempotencyKey: `subscription-${idempotencyKey}` }
    );

    if (!customer || !subscription) {
      logger.error('Empty objects creating Stripe account');
      return undefined;
    }

    return {
      customerId: customer.id,
      subscriptionId: subscription.id,
      currentPeriodEnd: subscription.current_period_end,
      currentPeriodStart: subscription.current_period_start
    };
  } catch (error) {
    logger.error('Error creating Stripe account:', error);
    return undefined;
  }
}
