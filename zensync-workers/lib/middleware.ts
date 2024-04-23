import { Env } from '@/interfaces/env.interface';
import {
  getSlackConnection,
  getZendeskCredentialsFromWebhookId,
  initializeDb
} from './database';
import { createHMACSignature, timingSafeEqual } from './utils';
import { RequestInterface } from '@/interfaces/request.interface';
import Stripe from 'stripe';
import { safeLog } from './logging';
import { importEncryptionKeyFromEnvironment, decryptData } from './encryption';
import bcrypt from 'bcryptjs';

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
    const mySignature = await createHMACSignature(
      signingSecret,
      basestring,
      'hex'
    );

    const computedSignature = `v0=${mySignature}`;

    // Compare the computed signature and the Slack signature
    const isValid = timingSafeEqual(computedSignature, slackSignature || '');

    if (!isValid) {
      safeLog('warn', 'Slack verification failed!');
      return new Response('Verification failed', {
        status: 200
      });
    }

    // Extract the team id from the request
    let teamId: string = null;
    if (request.bodyJson) {
      teamId = request.bodyJson.team_id;
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
      teamId = payload.team.id;
    }

    if (!teamId) {
      safeLog('error', 'No team_id found in request', request.bodyRaw);
      return new Response('Verification failed', {
        status: 200
      });
    }

    // Get the slack connection
    const slackConnectionInfo = await getSlackConnection(
      request.db,
      env,
      'teamId',
      teamId
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

///////////////////////////////////////////////
// Verify Zendesk webook
//////////////////////////////////////////////

export async function verifyZendeskWebhookAndSetSlackConnection(
  request: RequestInterface,
  env: Env
) {
  try {
    const requestString = request.bodyRaw;
    const timestamp = request.headers.get(
      'x-zendesk-webhook-signature-timestamp'
    );
    const webhookSignature = request.headers.get('x-zendesk-webhook-signature');
    const authorizationHeader = request.headers.get('authorization');
    const webhookId = request.headers.get('x-zendesk-webhook-id');
    const bearerToken = authorizationHeader?.replace('Bearer ', '');

    if (!bearerToken) {
      safeLog('error', 'Missing bearer token');
      return new Response('Verification failed', {
        status: 401
      });
    }

    const url = new URL(request.url);

    if (!webhookId || !webhookSignature || !timestamp) {
      safeLog('error', 'Missing zendesk headers id');
      return new Response('Verification failed', {
        status: 401
      });
    }

    const encryptionKey = await importEncryptionKeyFromEnvironment(env);
    const connection = await getZendeskCredentialsFromWebhookId(
      request.db,
      env,
      webhookId,
      encryptionKey
    );
    if (!connection) {
      safeLog('error', `Invalid webhook Id ${webhookId}`);
      return new Response('Verification failed', {
        status: 401
      });
    }

    if (!connection.encryptedZendeskSigningSecret) {
      safeLog('error', 'No zendesk signing secret found');
      return new Response('Verification failed', {
        status: 401
      });
    }

    const hashedToken = connection.hashedWebhookBearerToken;
    const isValidBearerToken = await bcrypt.compare(bearerToken, hashedToken);
    if (!isValidBearerToken) {
      safeLog('warn', 'Invalid bearer token');
      return new Response('Verification failed', {
        status: 401
      });
    }

    const decryptedSigningSecret = await decryptData(
      connection.encryptedZendeskSigningSecret,
      encryptionKey
    );
    const sigBase = timestamp + requestString;
    const computedSignature = await createHMACSignature(
      decryptedSigningSecret,
      sigBase,
      'base64'
    );

    // Compare the computed signature and the Slack signature
    const isValidSignature = timingSafeEqual(
      computedSignature,
      webhookSignature || ''
    );

    if (!isValidSignature) {
      safeLog('warn', 'Zendesk verification failed!');
      return new Response('Verification failed', {
        status: 401
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
        status: 401
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
      status: 503,
      headers: {
        'retry-after': '5'
      }
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
