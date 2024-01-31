import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { db } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import { zendeskConnection, ZendeskConnection, slackConnection, SlackConnection } from '@/lib/schema';


export enum InteractivityActionId {
  CONFIGURE_ZENDESK_BUTTON_TAPPED = 'configure-zendesk'
};


export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export async function verifySlackRequest(request: Request): Promise<boolean> {
  const signingSecret = process.env.SLACK_SIGNING_SECRET!;
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
  organizationId: string
): Promise<ZendeskConnection | null> {
  const zendeskCredentials = await db.query.zendeskConnection.findFirst({
    where: eq(zendeskConnection.organizationId, organizationId)
  });
  const zendeskDomain = zendeskCredentials?.zendeskDomain;
  const zendeskEmail = zendeskCredentials?.zendeskEmail;
  const zendeskApiKey = zendeskCredentials?.zendeskApiKey;

  if (!zendeskDomain || !zendeskEmail || !zendeskApiKey) {
    console.error(
      `Invalid Zendesk credentials found for organization ${organizationId}`
    );
    return null;
  }

  return zendeskCredentials;
}

export async function findSlackConnectionByTeamId(
  teamId: string | undefined
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
