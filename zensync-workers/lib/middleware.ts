import { Env } from '@/interfaces/env.interface';
import { getSlackConnectionFromId, initializeDb } from './database';
import { RequestInterface } from '@/interfaces/request.interface';
import { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './schema-sqlite';
import { eq } from 'drizzle-orm';
import { zendeskConnection, slackConnection } from '@/lib/schema-sqlite';
import { safeLog } from './logging';
import bcrypt from 'bcryptjs';

///////////////////////////////////////////////
// Inject the database to the request objece
//////////////////////////////////////////////
export async function injectDB(request: RequestInterface, env: Env) {
  request.db = initializeDb(env);
}

///////////////////////////////////////////////
// Verify Slack request and associated helpers
//////////////////////////////////////////////

export async function verifySlackRequest(request: Request, env: Env) {
  const signingSecret = env.SLACK_SIGNING_SECRET;
  const timestamp = request.headers.get('x-slack-request-timestamp');
  const slackSignature = request.headers.get('x-slack-signature');
  const body = await request.clone().text();

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
  const isValid = timingSafeEqual(computedSignature, slackSignature || '');

  if (!isValid) {
    safeLog('warn', 'Slack verification failed!');
    return new Response('Verification failed', {
      status: 200
    });
  }
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

///////////////////////////////////////////////
// Verify Zendesk webook
//////////////////////////////////////////////

export async function verifyZendeskWebhookAndSetSlackConnection(
  request: RequestInterface,
  env: Env
) {
  try {
    const authorizationHeader = request.headers.get('authorization');
    const webhookId = request.headers.get('x-zendesk-webhook-id');
    const bearerToken = authorizationHeader?.replace('Bearer ', '');

    if (!bearerToken) {
      safeLog('error', 'Missing bearer token');
      return new Response('Verification failed', {
        status: 200
      });
    }

    const url = new URL(request.url);

    if (!webhookId) {
      safeLog('error', 'Missing webhook id');
      return new Response('Verification failed', {
        status: 200
      });
    }

    const connection = await request.db.query.zendeskConnection.findFirst({
      where: eq(zendeskConnection.zendeskWebhookId, webhookId)
    });

    if (!connection) {
      safeLog('error', `Invalid webhook Id ${webhookId}`);
      return new Response('Verification failed', {
        status: 200
      });
    }

    const hashedToken = connection.hashedWebhookBearerToken;
    const isValid = await bcrypt.compare(bearerToken, hashedToken);
    if (!isValid) {
      safeLog('error', 'Invalid bearer token');
      return new Response('Verification failed', {
        status: 200
      });
    }

    // Get the slack connection
    const slackConnectionInfo = await getSlackConnectionFromId(request.db, env, connection.slackConnectionId);
    if (!slackConnectionInfo) {
      safeLog('error', 'No slack connection found');
      return new Response('Verification failed', {
        status: 200
      });
    }

    // Set the slack connection to the request object
    request.slackConnection = slackConnectionInfo;
  } catch (error) {
    safeLog('error', 'Error in authenticateRequest:', error);
    return new Response('Unknown verification error', {
      status: 500
    });
  }
}
