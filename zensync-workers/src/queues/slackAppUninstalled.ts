import { initializeDb } from '@/lib/drizzle';
import { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as schema from '@/lib/schema';
import { channel, SlackConnection } from '@/lib/schema';
import { eq, and } from 'drizzle-orm';
import { Env } from '@/interfaces/env.interface';
import { safeLog } from '@/lib/logging';

export async function slackAppUninstalled(requestJson: any, env: Env) {
  try {
    const connectionDetails: SlackConnection = requestJson.connectionDetails;
    if (!connectionDetails) {
      safeLog('error', 'No connection details found', requestJson);
      return;
    }

    const db = initializeDb(env);

    await leaveAllChannels(db, connectionDetails.id);
  } catch (error) {
    safeLog('error', error);
    throw error;
  }
}

async function leaveAllChannels(
  db: NeonHttpDatabase<typeof schema>,
  connectionId: string
) {
  try {
    await db
      .update(channel)
      .set({ isMember: false, updatedAt: new Date() })
      .where(
        and(
          eq(channel.slackConnectionId, connectionId),
          eq(channel.isMember, true)
        )
      );
  } catch (error) {
    safeLog('error', error);
    throw error;
  }
}
