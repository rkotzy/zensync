import { eq } from 'drizzle-orm';
import { subscription, slackConnection } from '@/lib/schema-sqlite';
import { Env } from '@/interfaces/env.interface';
import Stripe from 'stripe';
import { initializePosthog } from '@/lib/posthog';
import { getChannelsByProductId } from '@/interfaces/products.interface';
import { safeLog } from '@/lib/logging';
import { RequestInterface } from '@/interfaces/request.interface';
import { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '@/lib/schema-sqlite';

export class StripeEventHandler {
  async handle(
    request: RequestInterface,
    env: Env,
    context: any,
    data: Record<string, any>
  ) {
    // Handle the event
    const event = request.stripeEvent;
    switch (event.type) {
      case 'customer.subscription.deleted':
        await updateCustomerSubscription(event.data.object, request.db, env);
        break;
      case 'customer.subscription.updated':
        await updateCustomerSubscription(event.data.object, request.db, env);
        break;
      default:
        safeLog('log', `Unhandled event type ${event.type}`);
    }

    // Return a response to acknowledge receipt of the event
    return new Response('Ok', { status: 200 });
  }
}

async function updateCustomerSubscription(
  data: Stripe.Subscription,
  db: DrizzleD1Database<typeof schema>,
  env: Env
) {
  try {
    const subscriptionId = data.id;
    const productId = data.items.data[0].price.product.toString();

    const slackConnectionInfo = await db
      .select()
      .from(slackConnection)
      .fullJoin(
        subscription,
        eq(slackConnection.subscriptionId, subscription.id)
      )
      .where(eq(subscription.stripeSubscriptionId, subscriptionId))
      .limit(1);

    if (!slackConnectionInfo[0]) {
      safeLog('error', `Subscription not found: ${subscriptionId}`);
      throw new Error(`Subscription not found: ${subscriptionId}`);
    }

    const connectionInfo = slackConnectionInfo[0];
    const subscriptionInfo = connectionInfo.subscriptions;

    if (new Date(subscriptionInfo.updatedAt) > new Date(data.created * 1000)) {
      safeLog('warn', 'Out of date subscription event');
      return;
    }

    const currentPeriodEnd = new Date(
      data.current_period_end * 1000
    ).toISOString();
    const currentPeriodStart = new Date(
      data.current_period_start * 1000
    ).toISOString();
    const canceledAt = data.canceled_at
      ? new Date(data.canceled_at * 1000).toISOString()
      : null;

    await db
      .update(subscription)
      .set({
        updatedAt: new Date(data.created * 1000).toISOString(),
        periodStart: currentPeriodStart,
        periodEnd: currentPeriodEnd,
        canceledAt: canceledAt,
        ...(productId ? { stripeProductId: productId } : {})
      })
      .where(eq(subscription.stripeSubscriptionId, subscriptionId));

    // Fire off the queue to update channels
    await env.STRIPE_SUBSCRIPTION_CHANGED_QUEUE_BINDING.send({
      productId: productId,
      subscriptionId: subscriptionInfo.id
    });

    // Capture analytics
    if (canceledAt && subscriptionInfo.canceledAt === null) {
      const posthog = initializePosthog(env);
      posthog.capture({
        event: 'subscription_cancelled',
        distinctId: 'static_string_for_group_events',
        groups: { company: connectionInfo.slack_connections.appId }
      });
      await posthog.shutdown();
    } else if (
      getChannelsByProductId(productId) <
      getChannelsByProductId(subscriptionInfo.stripeProductId)
    ) {
      const posthog = initializePosthog(env);
      posthog.capture({
        event: 'subscription_downgraded',
        distinctId: 'static_string_for_group_events',
        groups: { company: connectionInfo.slack_connections.appId }
      });
      await posthog.shutdown();
    } else if (
      getChannelsByProductId(productId) >
      getChannelsByProductId(subscriptionInfo.stripeProductId)
    ) {
      const posthog = initializePosthog(env);
      posthog.capture({
        event: 'subscription_upgraded',
        distinctId: 'static_string_for_group_events',
        groups: { company: connectionInfo.slack_connections.appId }
      });
      await posthog.shutdown();
    }
  } catch (error) {
    safeLog('error', `Error updating customer subscription:`, error);
    throw new Error(`Error updating customer subscription: ${error}`);
  }
}
