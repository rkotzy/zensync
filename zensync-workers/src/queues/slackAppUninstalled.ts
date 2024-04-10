import { initializeDb } from '@/lib/database';
import { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '@/lib/schema-sqlite';
import { channel, SlackConnection } from '@/lib/schema-sqlite';
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
  db: DrizzleD1Database<typeof schema>,
  connectionId: number
) {
  try {
    await db
      .update(channel)
      .set({ isMember: false, updatedAt: new Date().toISOString() })
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
