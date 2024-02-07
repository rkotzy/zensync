import { OpenAPIRouter } from '@cloudflare/itty-router-openapi';
import { ZendeskEventHandler } from './endpoints/zendeskEvents';
import { SlackInteractivityHandler } from './endpoints/slackInteractivity';
import { SlackAuthRedirect } from './endpoints/slackAuthRedirect';
import { SlackAuthCallback } from './endpoints/slackAuthCallback';

export const router = OpenAPIRouter();

router.post(`/api/v1/zendesk/events`, ZendeskEventHandler);
router.post(`/api/v1/slack/interactivity`, SlackInteractivityHandler);
router.get(`/api/v1/slack/auth/redirect`, SlackAuthRedirect);
router.get(`/api/v1/slack/auth/callback`, SlackAuthCallback);
//router.post(`/api/v1/slack/events`, );

// Queue consumers
//router.post(`/api/v1/slack/worker/files`, );
//router.post(`/api/v1/slack/worker/messages`, );

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
  fetch: router.handle
};

export default worker;
