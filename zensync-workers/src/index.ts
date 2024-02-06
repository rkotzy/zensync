import { Router } from 'itty-router';
import { handler as zendeskEventsHandler } from './endpoints/zendeskEvents';

const API_PREFIX = '/api/v1';

export const router = Router();

router.post(`${API_PREFIX}/zendesk/events`, zendeskEventsHandler);

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

// Cloudflare Workers entry point
// addEventListener('fetch', (request, env, ctx) => {
//   event.respondWith(router.handle(request, env, ctx));
// });

export default {
  fetch: (request, env, ctx) => router.handle(request, env, ctx)
};
