import { OpenAPIRouter } from '@cloudflare/itty-router-openapi';
import { ZendeskEventHandler } from './endpoints/zendeskEvents';
import { SlackInteractivityHandler } from './endpoints/slackInteractivity';
import { SlackAuthRedirect } from './endpoints/slackAuthRedirect';
import { SlackAuthCallback } from './endpoints/slackAuthCallback';
import { SlackEventHandler } from './endpoints/slackEvents';
import { StripeEventHandler } from './endpoints/stripeEvents';
import { QueueMessageHandler } from './queues/queueHandler';
import { logRequestAndResponse } from '@/lib/logger';

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

async function handleWithLogging(request, env, ctx) {
  const startTime = Date.now();

  const requestId = crypto.randomUUID();

  const newRequest = new Request(request, {
    headers: new Headers(request.headers)
  });

  newRequest.headers.set('X-Request-ID', requestId);

  const response = await router.handle(newRequest);

  const duration = Date.now() - startTime;

  ctx.waitUntil(
    logRequestAndResponse(newRequest, response, duration, ctx, env)
  );

  return response;
}

const worker: ExportedHandler = {
  async fetch(request, env, ctx) {
    return handleWithLogging(request, env, ctx);
  },
  queue: message.handle.bind(message)
};

export default worker;
