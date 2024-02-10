import { eq } from 'drizzle-orm';
import {
  zendeskConnection,
  ZendeskConnection,
  slackConnection,
  SlackConnection
} from '@/lib/schema';
import * as schema from '@/lib/schema';
import { NeonHttpDatabase } from 'drizzle-orm/neon-http';

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
  EDIT_CHANNEL_TAGS_FIELD = 'edit-channel-tags-input'
}

export interface Env {
  SLACK_SIGNING_SECRET: string;
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
  db: NeonHttpDatabase<typeof schema>
): Promise<ZendeskConnection | null> {
  const zendeskCredentials = await db.query.zendeskConnection.findFirst({
    where: eq(zendeskConnection.slackConnectionId, slackConnectionId)
  });
  const zendeskDomain = zendeskCredentials?.zendeskDomain;
  const zendeskEmail = zendeskCredentials?.zendeskEmail;
  const zendeskApiKey = zendeskCredentials?.zendeskApiKey;

  if (!zendeskDomain || !zendeskEmail || !zendeskApiKey) {
    console.log(
      `No Zendesk credentials found for slack connection ${slackConnectionId}`
    );
    return null;
  }

  return zendeskCredentials;
}

export async function findSlackConnectionByTeamId(
  teamId: string | undefined,
  db: NeonHttpDatabase<typeof schema>
): Promise<SlackConnection | null | undefined> {
  if (!teamId) {
    console.error('No team_id found');
    return undefined;
  }

  try {
    const connection = await db.query.slackConnection.findFirst({
      where: eq(slackConnection.slackTeamId, teamId)
    });

    return connection;
  } catch (error) {
    console.error('Error querying SlackConnections:', error);
    return undefined;
  }
}
