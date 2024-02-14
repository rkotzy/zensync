import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import * as schema from './schema';

export function initializeDb(env) {
  const sql = neon(env.POSTGRES_URL);
  const db = drizzle(sql, { schema: schema });
  return db;
}
