import { OpenAPIRoute } from '@cloudflare/itty-router-openapi';
import { initializeDb } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import { subscription, slackConnection } from '@/lib/schema';
import { Env } from '@/interfaces/env.interface';
import Stripe from 'stripe';
import { initializePosthog } from '@/lib/posthog';
import { getChannelsByProductId } from '@/interfaces/products.interface';
import { safeLog } from '@/lib/logging';

export class StripeEventHandler extends OpenAPIRoute {
  async handle(
    request: Request,
    env: Env,
    context: any,
    data: Record<string, any>
  ) {
    const body = await request.text();

    safeLog('log', 'Stripe event received:', body);

    const stripe = new Stripe(env.STRIPE_API_KEY);
    const sig = request.headers.get('stripe-signature');

    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(
        body,
        sig,
        env.STRIPE_ENDPOINT_SECRET
      );

      // Handle the event
      switch (event.type) {
        case 'customer.subscription.deleted':
          await updateCustomerSubscription(event.data.object, env);
          break;
        case 'customer.subscription.updated':
          await updateCustomerSubscription(event.data.object, env);
          break;
        default:
          safeLog('log', `Unhandled event type ${event.type}`);
      }
    } catch (error) {
      safeLog('error', `Error constructing Stripe event:`, error);
      return new Response(`Webhook error ${error}`, { status: 400 });
    }

    // Return a response to acknowledge receipt of the event
    return new Response('Ok', { status: 200 });
  }
}

async function updateCustomerSubscription(data: Stripe.Subscription, env: Env) {
  try {
    const subscriptionId = data.id;
    const productId = data.items.data[0].price.product.toString();

    const db = initializeDb(env);

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

    if (subscriptionInfo.updatedAt > new Date(data.created * 1000)) {
      safeLog('warn', 'Out of date subscription event');
      return;
    }

    const currentPeriodEnd = new Date(data.current_period_end * 1000);
    const currentPeriodStart = new Date(data.current_period_start * 1000);
    const canceledAt = data.canceled_at
      ? new Date(data.canceled_at * 1000)
      : null;

    await db
      .update(subscription)
      .set({
        updatedAt: new Date(data.created * 1000),
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
