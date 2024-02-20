import { OpenAPIRoute } from '@cloudflare/itty-router-openapi';
import { initializeDb } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import { subscription, subscriptionPlan } from '@/lib/schema';
import { Logtail } from '@logtail/edge';
import { EdgeWithExecutionContext } from '@logtail/edge/dist/es6/edgeWithExecutionContext';
import { Env } from '@/interfaces/env.interface';
import Stripe from 'stripe';

export class StripeEventHandler extends OpenAPIRoute {
  async handle(
    request: Request,
    env: Env,
    context: any,
    data: Record<string, any>
  ) {
    // Set up logger right away
    const baseLogger = new Logtail(env.BETTER_STACK_SOURCE_TOKEN);
    const logger = baseLogger.withExecutionContext(context);

    const body = await request.text();
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
          await updateCustomerSubscription(event.data.object, env, logger);
          break;
        case 'customer.subscription.updated':
          await updateCustomerSubscription(event.data.object, env, logger);
          break;
        default:
          logger.info(`Unhandled event type ${event.type}`);
      }
    } catch (err) {
      logger.error(`Error constructing Stripe event: ${err}`);
      return new Response(`Webhook error ${err}`, { status: 400 });
    }

    // Return a response to acknowledge receipt of the event
    return new Response('Ok', { status: 200 });
  }
}

async function updateCustomerSubscription(
  data: Stripe.Subscription,
  env: Env,
  logger: EdgeWithExecutionContext
) {
  try {
    const subscriptionId = data.id;
    const productId = data.items.data[0].price.product.toString();

    const db = initializeDb(env);

    const subscriptionInfo = await db.query.subscription.findFirst({
      where: eq(subscription.stripeSubscriptionId, subscriptionId),
      with: {
        subscriptionPlan: true
      }
    });

    if (!subscriptionInfo) {
      logger.error('Subscription not found');
      throw new Error('Subscription not found');
    }

    if (subscriptionInfo.updatedAt > new Date(data.created * 1000)) {
      logger.warn('Out of date subscription event');
      return;
    }

    let newPlanId: string;
    if (productId !== subscriptionInfo.subscriptionPlan.stripeProductId) {
      const newPlan = await db.query.subscriptionPlan.findFirst({
        where: eq(subscriptionPlan.stripeProductId, productId)
      });

      if (!newPlan) {
        logger.error(`No plan found for ${productId}`);
        throw new Error('Plan not found');
      }
      newPlanId = newPlan.id;
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
        ...(newPlanId ? { subscriptionPlanId: newPlanId } : {})
      })
      .where(eq(subscription.stripeSubscriptionId, subscriptionId));
  } catch (err) {
    logger.error(`Error updating customer subscription ${err}`);
    throw new Error(`Error updating customer subscription: ${err}`);
  }
}
