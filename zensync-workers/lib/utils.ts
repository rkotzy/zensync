import { SlackConnection, Channel } from '@/lib/schema-sqlite';
import { Env } from '@/interfaces/env.interface';
import Stripe from 'stripe';
import { SlackMessageData } from '@/interfaces/slack-api.interface';
import { safeLog } from './logging';

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

  // Channel settings modal details
  OPEN_CHANNEL_SETTINGS_BUTTON_TAPPED = 'open-channel-settings',
  CHANNEL_SETTINGS_MODAL_ID = 'channel-settings-modal',
  SAME_SENDER_IN_TIMEFRAME_FIELD = 'same-sender-in-timeframe-input',

  // Billing settings modal details
  OPEN_ACCOUNT_SETTINGS_BUTTON_TAPPED = 'open-account-settings'
}

export function convertTimestampToDate(timestamp: number | string): Date {
  const parsedTimestamp =
    typeof timestamp === 'string' ? parseFloat(timestamp) : timestamp;
  const timestampInMilliseconds = parsedTimestamp * 1000;
  return new Date(timestampInMilliseconds);
}

export function isSubscriptionActive(
  connection: SlackConnection,
  env: Env
): boolean {
  if (!connection.subscription?.periodEndMs) {
    safeLog('error', `periodEnd is missing for connection ${connection.id}`);
    return true; // Assuming missing data or configuration should be treated as active
  }

  const periodEnd = connection.subscription.periodEndMs;
  const bufferMilliseconds =
    env.SUBSCRIPTION_EXPIRATION_BUFFER_HOURS * 60 * 60 * 1000; // Convert hours to milliseconds
  const expirationDateWithBuffer = periodEnd + bufferMilliseconds;

  return expirationDateWithBuffer >= new Date().getTime(); // Return true if subscription is active (not yet expired)
}

export function isChannelEligibleForMessaging(channel: Channel): boolean {
  return channel.isMember && channel.status !== 'PENDING_UPGRADE';
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
        items: [{ price: env.DEFAULT_STRIPE_PRICE_ID }] // Default free plan
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

// Timing-safe string comparison used in verifySlackRequest
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return mismatch === 0;
}

// Utility to create HMAC signature and return it as base64-encoded string
export async function createHMACSignature(
  secret: string,
  data: string,
  encoding: 'hex' | 'base64'
): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(data);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    messageData
  );
  if (encoding === 'hex') {
    return Array.from(new Uint8Array(signatureBuffer))
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('');
  } else {
    // 'base64'
    return btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
  }
}

export function generateExternalId(channelId: string, ts: string): string {
  return `zensync-${channelId}:${ts}`;
}

export function getParentMessageId(event: SlackMessageData): string | null {
  if (event.thread_ts && event.thread_ts !== event.ts) {
    return event.thread_ts;
  }

  return null;
}

export function needsFollowUpTicket(responseJson: any): boolean {
  if (responseJson.error === 'RecordInvalid' && responseJson.details?.status) {
    // Handles updates on closed tickets
    const statusDetails = responseJson.details.status.find((d: any) =>
      d.description.includes('Status: closed prevents ticket update')
    );
    return !!statusDetails;
  } else if (responseJson.error === 'RecordNotFound') {
    // Handles replies to deleted tickets
    return true;
  }
  return false;
}

export function getChannelType(channelData: any): string | null {
  if (typeof channelData !== 'object' || channelData === null) {
    safeLog('warn', 'Invalid or undefined channel data received:', channelData);
    return null;
  }

  if (channelData.is_channel) {
    return 'PUBLIC';
  } else if (channelData.is_private) {
    return 'PRIVATE';
  } else if (channelData.is_im) {
    return 'DM';
  } else if (channelData.is_mpim) {
    return 'GROUP_DM';
  }

  safeLog('warn', `Unkonwn channel type: ${channelData}`);
  return null;
}
