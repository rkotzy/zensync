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

export async function getSlackConnection(
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  searchKey: 'id',
  searchValue: number
): Promise<SlackConnection | null | undefined>;

export async function getSlackConnection(
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  searchKey: 'appId',
  searchValue: string
): Promise<SlackConnection | null | undefined>;

export async function getSlackConnection(
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  searchKey: any,
  searchValue: any
): Promise<SlackConnection | null | undefined> {
  let whereCondition;

  if (searchKey === 'id') {
    whereCondition = eq(slackConnection.id, searchValue);
  } else if (searchKey === 'appId') {
    whereCondition = eq(slackConnection.appId, searchValue);
  } else {
    throw new Error('Invalid search key');
  }

  const connection = await db.query.slackConnection.findFirst({
    where: whereCondition,
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
