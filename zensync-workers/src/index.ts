import { OpenAPIRouter } from '@cloudflare/itty-router-openapi';
import { ZendeskEventHandler } from './endpoints/zendeskEvents';
import { SlackInteractivityHandler } from './endpoints/slackInteractivity';
import { SlackAuthRedirect } from './endpoints/slackAuthRedirect';
import { SlackAuthCallback } from './endpoints/slackAuthCallback';
import { ZendeskAuthCallback } from './endpoints/zendeskAuthCallback';
import { SlackEventHandler } from './endpoints/slackEvents';
import { StripeEventHandler } from './endpoints/stripeEvents';
import { SyncSubscriptionHandler } from './endpoints/syncSubscription';
import { QueueMessageHandler } from './queues/queueHandler';

export const router = OpenAPIRouter();
const message = new QueueMessageHandler();

router.get(`/v1/zendesk/auth/callback`, ZendeskAuthCallback);
router.post(`/v1/zendesk/events`, ZendeskEventHandler);
router.post(`/v1/slack/interactivity`, SlackInteractivityHandler);
router.get(`/v1/slack/auth/redirect`, SlackAuthRedirect);
router.get(`/v1/slack/auth/callback`, SlackAuthCallback);
router.post(`/v1/slack/events`, SlackEventHandler);
router.post(`/v1/stripe/events`, StripeEventHandler);
router.post(`/internal/syncSubscription`, SyncSubscriptionHandler);

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
