import { Env } from '@/interfaces/env.interface';
import {
  getSlackConnection,
  getZendeskCredentialsFromWebhookId,
  initializeDb
} from './database';
import { RequestInterface } from '@/interfaces/request.interface';
import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { zendeskConnection } from '@/lib/schema-sqlite';
import { safeLog } from './logging';
import bcrypt from 'bcryptjs';
import { SlackEvent } from '@/interfaces/slack-api.interface';

///////////////////////////////////////////////
// Inject the database to the request objece
//////////////////////////////////////////////
export async function injectDB(request: RequestInterface, env: Env) {
  request.db = initializeDb(env);
}

///////////////////////////////////////////////
// Parse the request body
//////////////////////////////////////////////
export async function parseRequest(request: RequestInterface, env: Env) {
  try {
    const requestCloneForText = request.clone();
    const requestText = await requestCloneForText.text();

    let requestJson;
    try {
      requestJson = JSON.parse(requestText);
    } catch (error) {
      requestJson = null;
    }

    const requestCloneForFormData = request.clone();
    let formData;
    try {
      formData = await requestCloneForFormData.formData();
      const formDataObject = {};
      for (const [key, value] of formData.entries()) {
        formDataObject[key] = value;
      }
      formData = formDataObject;
    } catch (error) {
      formData = null;
    }

    request.bodyRaw = requestText;
    request.bodyJson = requestJson;
    request.bodyFormData = formData;
  } catch (error) {
    console.error('Error parsing request:', error);
    return new Response('Error parsing request', {
      status: 500
    });
  }
}

///////////////////////////////////////////////
// Verify Slack request and associated helpers
//////////////////////////////////////////////

export async function verifySlackRequestAndSetSlackConnection(
  request: RequestInterface,
  env: Env
) {
  try {
    const requestString = request.bodyRaw;
    const signingSecret = env.SLACK_SIGNING_SECRET;
    const timestamp = request.headers.get('x-slack-request-timestamp');
    const slackSignature = request.headers.get('x-slack-signature');

    const basestring = `v0:${timestamp}:${requestString}`;

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

    // Extract the app id from the request
    let appId: string = null;
    if (request.bodyJson) {
      appId = request.bodyJson.api_app_id;
    } else if (request.bodyFormData) {
      const payloadString = request.bodyFormData.payload;
      // Make sure we have a payload
      if (typeof payloadString !== 'string') {
        safeLog(
          'error',
          'No payload string in form body',
          request.bodyFormData
        );
        return new Response('Invalid payload', { status: 200 });
      }

      // Parse the JSON string into an object
      const payload = JSON.parse(payloadString);
      request.bodyJson = payload;
      appId = payload.api_app_id;
    }

    if (!appId) {
      safeLog('error', 'No api_app_id found in request', request.bodyRaw);
      return new Response('Verification failed', {
        status: 200
      });
    }

    // Get the slack connection
    const requestJson = request.bodyJson as SlackEvent;
    const slackConnectionInfo = await getSlackConnection(
      request.db,
      env,
      'appId',
      requestJson.api_app_id
    );

    if (!slackConnectionInfo) {
      safeLog('error', 'No slack connection found');
      return new Response('Verification failed', {
        status: 200
      });
    }

    // Update the request object
    request.slackConnection = slackConnectionInfo;
  } catch (error) {
    safeLog(
      'error',
      'Error in verifySlackRequestAndSetSlackConnection:',
      error
    );
    return new Response('Unknown verification error', {
      status: 500
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

    const connection = await getZendeskCredentialsFromWebhookId(
      request.db,
      webhookId
    );
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
    const slackConnectionInfo = await getSlackConnection(
      request.db,
      env,
      'id',
      connection.slackConnectionId
    );
    if (!slackConnectionInfo) {
      safeLog('error', 'No slack connection found');
      return new Response('Verification failed', {
        status: 200
      });
    }

    // Set the slack connection to the request object
    request.slackConnection = slackConnectionInfo;
  } catch (error) {
    safeLog(
      'error',
      'Error in verifyZendeskWebhookAndSetSlackConnection:',
      error
    );
    return new Response('Unknown verification error', {
      status: 500
    });
  }
}

///////////////////////////////////////////////
// Verify Stripe webook
//////////////////////////////////////////////

export async function verifyStripeWebhook(request: RequestInterface, env: Env) {
  try {
    const body = request.bodyRaw;

    const stripe = new Stripe(env.STRIPE_API_KEY);
    const sig = request.headers.get('stripe-signature');

    const event = await stripe.webhooks.constructEventAsync(
      body,
      sig,
      env.STRIPE_ENDPOINT_SECRET
    );

    request.stripeEvent = event;
  } catch (error) {
    safeLog('error', `Error constructing Stripe event:`, error);
    return new Response(`Webhook error ${error}`, { status: 400 });
  }
}
