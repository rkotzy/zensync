import { initializeDb } from '@/lib/drizzle';
import { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as schema from '@/lib/schema';
import { slackConnection, channel } from '@/lib/schema';
import { eq, and, asc, lte, gt } from 'drizzle-orm';
import { Env } from '@/interfaces/env.interface';
import { EdgeWithExecutionContext } from '@logtail/edge/dist/es6/edgeWithExecutionContext';
import { getChannelsByProductId } from '@/interfaces/products.interface';

const PENDING_UPGRADE = 'PENDING_UPGRADE';

export async function stripeSubscriptionChanged(
  requestJson: any,
  env: Env,
  logger: EdgeWithExecutionContext
) {
  try {
    const db = initializeDb(env);
    await updateChannelStatus(db, requestJson, logger);
  } catch (error) {
    logger.error(error);
    throw error;
  }
}

async function updateChannelStatus(
  db: NeonHttpDatabase<typeof schema>,
  requestJson: any,
  logger: EdgeWithExecutionContext
) {
  // Get current Stripe subscription
  const productId = requestJson.productId;
  const subscriptionId = requestJson.subscriptionId;

  if (!productId || !subscriptionId) {
    logger.error('Missing required parameters');
    return;
  }

  const connection = await db.query.slackConnection.findFirst({
    where: eq(slackConnection.subscriptionId, subscriptionId)
  });

  if (!connection) {
    logger.error('No connection found for subscription');
    return;
  }

  // Get number of eligible channels in current subscription
  const channelLimit = getChannelsByProductId(productId);

  const allChannels = await db.query.channel.findMany({
    where: and(
      eq(channel.slackConnectionId, connection.id),
      eq(channel.isMember, true)
    ),
    orderBy: [asc(channel.createdAt)]
  });

  if (allChannels.length > channelLimit) {
    // If there are more channels than the limit

    // Check if the index is within bounds to prevent accessing undefined
    if (allChannels.length > 0 && channelLimit > 0) {
      const safeIndex = Math.min(channelLimit - 1, allChannels.length - 1);
      const lastActiveChannelDate = allChannels[safeIndex].createdAt;

      await activateChannels(db, connection.id, lastActiveChannelDate);
      await deactivateChannels(db, connection.id, lastActiveChannelDate);
    }
  } else {
    // If the total number of channels is within the limit, activate all that are pending
    await activateAllChannels(db, connection.id);
  }
}

async function deactivateChannels(
  db: NeonHttpDatabase<typeof schema>,
  connectionId: string,
  beyondLimit: Date
) {
  await db
    .update(channel)
    .set({ status: PENDING_UPGRADE })
    .where(
      and(
        eq(channel.slackConnectionId, connectionId),
        eq(channel.isMember, true),
        eq(channel.status, null),
        gt(channel.createdAt, beyondLimit)
      )
    );
}

async function activateChannels(
  db: NeonHttpDatabase<typeof schema>,
  connectionId: string,
  upToLimit: Date
) {
  await db
    .update(channel)
    .set({ status: null })
    .where(
      and(
        eq(channel.slackConnectionId, connectionId),
        eq(channel.isMember, true),
        eq(channel.status, PENDING_UPGRADE),
        lte(channel.createdAt, upToLimit)
      )
    );
}

async function activateAllChannels(
  db: NeonHttpDatabase<typeof schema>,
  connectionId: string
) {
  await db
    .update(channel)
    .set({ status: null })
    .where(
      and(
        eq(channel.slackConnectionId, connectionId),
        eq(channel.isMember, true),
        eq(channel.status, PENDING_UPGRADE)
      )
    );
}
