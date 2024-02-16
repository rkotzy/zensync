import { OpenAPIRouter } from '@cloudflare/itty-router-openapi';
import { ZendeskEventHandler } from './endpoints/zendeskEvents';
import { SlackInteractivityHandler } from './endpoints/slackInteractivity';
import { SlackAuthRedirect } from './endpoints/slackAuthRedirect';
import { SlackAuthCallback } from './endpoints/slackAuthCallback';
import { SlackEventHandler } from './endpoints/slackEvents';
import { StripeEventHandler } from './endpoints/stripeEvents';
import { QueueMessageHandler } from './queues/queueHandler';

export const router = OpenAPIRouter();
const message = new QueueMessageHandler();

router.post(`/v1/zendesk/events`, ZendeskEventHandler);
router.post(`/v1/slack/interactivity`, SlackInteractivityHandler);
router.get(`/v1/slack/auth/redirect`, SlackAuthRedirect);
router.get(`/v1/slack/auth/callback`, SlackAuthCallback);
router.post(`/v1/slack/events`, SlackEventHandler);
router.post(`/v1/stripe/events`, StripeEventHandler);

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
  fetch: router.handle,
  queue: message.handle.bind(message)
};

export default worker;
