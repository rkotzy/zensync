import { Env } from '@/interfaces/env.interface';
import { safeLog } from '@/lib/logging';
import { RequestInterface } from '@/interfaces/request.interface';
import { getSubscription } from '@/lib/database';

export class SyncSubscriptionHandler {
  async handle(
    request: RequestInterface,
    env: Env,
    context: any,
    data: Record<string, any>
  ) {
    try {
      const url = new URL(request.url);
      const subscriptionId = url.searchParams.get('subscription_id');
      if (!subscriptionId) {
        safeLog('error', 'Missing required parameters');
        return new Response('Missing required parameters', { status: 400 });
      }

      const db = request.db;

      const subscriptionInfo = await getSubscription(db, subscriptionId);

      if (!subscriptionInfo) {
        safeLog('error', 'No subscription found');
        return new Response('No subscription found', { status: 404 });
      }
      const productId = subscriptionInfo.stripeProductId;

      if (!productId) {
        safeLog('error', 'No product found');
        return new Response('No product found', { status: 404 });
      }

      // Fire off the queue to update channels
      await env.STRIPE_SUBSCRIPTION_CHANGED_QUEUE_BINDING.send({
        productId: productId,
        subscriptionId: subscriptionInfo.id
      });

      return new Response('Ok', { status: 200 });
    } catch (error) {
      safeLog('error', `Error syncing subscription: ${error}`);
      return new Response('Error syncing subscription', { status: 500 });
    }
  }
}
