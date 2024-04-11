import { OpenAPIRouter } from '@cloudflare/itty-router-openapi';
import {
  verifySlackRequestAndSetSlackConnection,
  injectDB,
  verifyZendeskWebhookAndSetSlackConnection,
  parseRequest
} from '@/lib/middleware';
import { ZendeskEventHandler } from './endpoints/zendeskEvents';
import { SlackInteractivityHandler } from './endpoints/slackInteractivity';
import { SlackAuthRedirect } from './endpoints/slackAuthRedirect';
import { SlackAuthCallback } from './endpoints/slackAuthCallback';
import { SlackEventHandler } from './endpoints/slackEvents';
import { StripeEventHandler } from './endpoints/stripeEvents';
import { SyncSubscriptionHandler } from './endpoints/syncSubscription';
import { QueueMessageHandler } from './queues/queueHandler';

export const router = OpenAPIRouter();
const message = new QueueMessageHandler();

///////////////////////////////////////////////
// Note: Order of middlware is important!
// e.g some middleare depends on DB injection, etc
///////////////////////////////////////////////

router.post(
  `/v1/zendesk/events`,
  parseRequest,
  injectDB,
  verifyZendeskWebhookAndSetSlackConnection,
  new ZendeskEventHandler()
);

router.post(
  `/v1/slack/interactivity`,
  parseRequest,
  injectDB,
  verifySlackRequestAndSetSlackConnection,
  new SlackInteractivityHandler()
);

router.get(`/v1/slack/auth/redirect`, injectDB, new SlackAuthRedirect());

router.get(`/v1/slack/auth/callback`, injectDB, new SlackAuthCallback());

router.post(
  `/v1/slack/events`,
  parseRequest,
  injectDB,
  verifySlackRequestAndSetSlackConnection,
  new SlackEventHandler()
);

router.post(
  `/v1/stripe/events`,
  parseRequest,
  injectDB,
  new StripeEventHandler()
);

router.post(
  `/internal/syncSubscription`,
  parseRequest,
  injectDB,
  new SyncSubscriptionHandler()
);

// 404 for everything else
router.all('*', () =>
  Response.json(
    {
      success: false,
      error: 'Route not found'
    },
    { status: 404 }
  )
);

const worker: ExportedHandler = {
  async fetch(request, env, ctx) {
    return await router.handle(request, env, ctx);
  },
  queue: message.handle.bind(message)
};

export default worker;
