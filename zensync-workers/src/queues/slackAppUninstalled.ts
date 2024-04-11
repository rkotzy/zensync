import { initializeDb, leaveAllChannels } from '@/lib/database';
import { SlackConnection } from '@/lib/schema-sqlite';
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
