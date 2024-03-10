import {
  OpenAPIRoute,
  OpenAPIRouteSchema,
  Query
} from '@cloudflare/itty-router-openapi';
import { Env } from '@/interfaces/env.interface';
import { initializeDb } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import { subscription } from '@/lib/schema';

export class SyncSubscriptionHandler extends OpenAPIRoute {
  static schema: OpenAPIRouteSchema = {
    parameters: {
      subscription_id: Query(String)
    }
  };
  async handle(
    request: Request,
    env: Env,
    context: any,
    data: Record<string, any>
  ) {
    try {
      const url = new URL(request.url);
      const subscriptionId = url.searchParams.get('subscription_id');
      if (!subscriptionId) {
        console.error('Missing required parameters');
        return new Response('Missing required parameters', { status: 400 });
      }

      const db = initializeDb(env);

      const subscriptionInfo = await db.query.subscription.findFirst({
        where: eq(subscription.stripeSubscriptionId, subscriptionId)
      });

      if (!subscriptionInfo) {
        console.error('No subscription found');
        return new Response('No subscription found', { status: 404 });
      }
      const productId = subscriptionInfo.stripeProductId;

      if (!productId) {
        console.error('No product found');
        return new Response('No product found', { status: 404 });
      }

      // Fire off the queue to update channels
      await env.STRIPE_SUBSCRIPTION_CHANGED_QUEUE_BINDING.send({
        productId: productId,
        subscriptionId: subscriptionInfo.id
      });

      return new Response('Ok', { status: 200 });
    } catch (error) {
      console.error(`Error syncing subscription: ${error}`);
      return new Response('Error syncing subscription', { status: 500 });
    }
  }
}
