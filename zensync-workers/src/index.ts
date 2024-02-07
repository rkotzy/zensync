import { OpenAPIRouter } from '@cloudflare/itty-router-openapi';
import { ZendeskEventHandler } from './endpoints/zendeskEvents';

export const router = OpenAPIRouter();

router.post(`/api/v1/zendesk/events`, ZendeskEventHandler);

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
