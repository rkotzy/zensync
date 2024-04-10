import { DrizzleD1Database, drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import * as schema from './schema-sqlite';
import { slackConnection, SlackConnection } from './schema-sqlite';
import { Env } from '@/interfaces/env.interface';
import { importEncryptionKeyFromEnvironment, decryptData } from './encryption';

export function initializeDb(env: Env) {
  const db = drizzle(env.DBSQLITE, { schema: schema });
  return db;
}

export async function getSlackConnectionFromId(
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  id: number
): Promise<SlackConnection | null | undefined> {
  const connection = await db.query.slackConnection.findFirst({
    where: eq(slackConnection.id, id),
    with: {
      subscription: true
    }
  });

  if (connection) {
    const encryptionKey = await importEncryptionKeyFromEnvironment(env);
    const decryptedToken = await decryptData(
      connection.encryptedToken,
      encryptionKey
    );

    return { ...connection, token: decryptedToken };
  }

  return null;
}
