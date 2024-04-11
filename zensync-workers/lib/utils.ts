import { eq, and } from 'drizzle-orm';
import {
  zendeskConnection,
  ZendeskConnection,
  slackConnection,
  SlackConnection,
  channel,
  Channel
} from '@/lib/schema-sqlite';
import * as schema from '@/lib/schema-sqlite';
import { Env } from '@/interfaces/env.interface';
import { decryptData, importEncryptionKeyFromEnvironment } from './encryption';
import Stripe from 'stripe';
import { PostHog } from 'posthog-node';
import { initializePosthog } from './posthog';
import { safeLog } from './logging';
import { DrizzleD1Database } from 'drizzle-orm/d1';

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
  OPEN_ACCOUNT_SETTINGS_BUTTON_TAPPED = 'open-account-settings'
}

export async function singleEventAnalyticsLogger(
  userId: string,
  event: string,
  connectionAppId: string,
  channelId: string | null,
  timestamp: number | string | null,
  uuid: string | null,
  properties: Record<string | number, any> | null,
  env: Env | null | undefined,
  posthog: PostHog | null | undefined
): Promise<void> {
  let client = posthog;
  if (!client) {
    client = initializePosthog(env);
  }

  if (!userId) {
    userId = 'static_string_for_group_events';
  }

  let dateTimestamp: Date | null = null;
  if (typeof timestamp === 'number' || typeof timestamp === 'string') {
    dateTimestamp = convertTimestampToDate(timestamp);
  }

  client.capture({
    timestamp: dateTimestamp,
    uuid: uuid,
    distinctId: userId,
    event: event,
    groups: { company: connectionAppId, channel: channelId },
    properties: properties
  });

  await client.shutdown();
}

function convertTimestampToDate(timestamp: number | string): Date {
  const parsedTimestamp =
    typeof timestamp === 'string' ? parseFloat(timestamp) : timestamp;
  const timestampInMilliseconds = parsedTimestamp * 1000;
  return new Date(timestampInMilliseconds);
}

export async function fetchZendeskCredentials(
  slackConnectionId: number,
  db: DrizzleD1Database<typeof schema>,
  env: Env,
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
      safeLog(
        'log',
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
    safeLog('error', `Error querying ZendeskConnections: ${error}`);
    return undefined;
  }
}

export function isSubscriptionActive(
  connection: SlackConnection,
  env: Env
): boolean {
  if (!connection.subscription?.periodEnd) {
    safeLog('error', `periodEnd is missing for connection ${connection.id}`);
    return true; // Assuming missing data or configuration should be treated as active
  }

  const periodEnd = connection.subscription.periodEnd;
  const bufferMilliseconds =
    env.SUBSCRIPTION_EXPIRATION_BUFFER_HOURS * 60 * 60 * 1000; // Convert hours to milliseconds
  const expirationDateWithBuffer =
    new Date(periodEnd).getTime() + bufferMilliseconds;

  return expirationDateWithBuffer >= new Date().getTime(); // Return true if subscription is active (not yet expired)
}

export async function getChannelInfo(
  channelId: string,
  slackConnectionId: number,
  db: DrizzleD1Database<typeof schema>
): Promise<Channel | null | undefined> {
  try {
    const channelInfo = await db.query.channel.findFirst({
      where: and(
        eq(channel.slackConnectionId, slackConnectionId),
        eq(channel.slackChannelIdentifier, channelId)
      )
    });

    return channelInfo;
  } catch (error) {
    safeLog('error', `Error getting channel info for ${channelId}`, error);
    return undefined;
  }
}

export function isChannelEligibleForMessaging(channel: Channel): boolean {
  return channel.isMember && channel.status !== 'PENDING_UPGRADE';
}

export async function updateChannelActivity(
  slackConnection: SlackConnection,
  channelId: string,
  db: DrizzleD1Database<typeof schema>
): Promise<void> {
  const now = new Date().toISOString();

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
  idempotencyKey: string
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
      safeLog(
        'error',
        `Empty objects creating Stripe account ${name}, ${email}`
      );
      return undefined;
    }

    return {
      customerId: customer.id,
      subscriptionId: subscription.id,
      currentPeriodEnd: subscription.current_period_end,
      currentPeriodStart: subscription.current_period_start
    };
  } catch (error) {
    safeLog('error', 'Error creating Stripe account:', error);
    return undefined;
  }
}
