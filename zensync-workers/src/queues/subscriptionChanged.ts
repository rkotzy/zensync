import {
  getChannels,
  initializeDb,
  deactivateChannels,
  activateChannels,
  activateAllChannels
} from '@/lib/database';
import { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '@/lib/schema-sqlite';
import { channel } from '@/lib/schema-sqlite';
import { eq, and, asc, lte, gt, isNull } from 'drizzle-orm';
import { Env } from '@/interfaces/env.interface';
import { getChannelsByProductId } from '@/interfaces/products.interface';
import { safeLog } from '@/lib/logging';

export async function stripeSubscriptionChanged(requestJson: any, env: Env) {
  safeLog('log', 'stripeSubscriptionChanged', requestJson);

  try {
    const db = initializeDb(env);
    await updateChannelStatus(db, requestJson);
  } catch (error) {
    safeLog('error', error);
    throw error;
  }
}

async function updateChannelStatus(
  db: DrizzleD1Database<typeof schema>,
  requestJson: any
) {
  // Get current Stripe subscription
  const productId = requestJson.productId;
  const slackConnectionInfo = requestJson.slackConnectionInfo;

  if (!productId || !slackConnectionInfo) {
    safeLog('error', 'Missing required parameters');
    return;
  }

  // Get number of eligible channels in current subscription
  const channelLimit = getChannelsByProductId(productId);

  const allChannels = await getChannels(db, slackConnectionInfo.id);

  if (allChannels.length > channelLimit) {
    // If there are more channels than the limit

    // Check if the index is within bounds to prevent accessing undefined
    if (allChannels.length > 0 && channelLimit > 0) {
      const safeIndex = Math.min(channelLimit - 1, allChannels.length - 1);
      const lastActiveChannelDate = allChannels[safeIndex].createdAt;

      await activateChannels(db, slackConnectionInfo.id, lastActiveChannelDate);
      await deactivateChannels(
        db,
        slackConnectionInfo.id,
        lastActiveChannelDate
      );
    }
  } else {
    // If the total number of channels is within the limit, activate all that are pending
    await activateAllChannels(db, slackConnectionInfo.id);
  }
}
