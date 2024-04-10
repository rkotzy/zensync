import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema-sqlite';
import { Env } from '@/interfaces/env.interface';

export function initializeDb(env: Env) {
  const db = drizzle(env.DBSQLITE, { schema: schema });
  return db;
}
