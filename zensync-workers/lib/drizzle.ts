import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as schema from './schema';

let db: NeonHttpDatabase<typeof schema>;
export function initializeDb(env) {
  if (db) {
    return db;
  }
  const sql = neon(env.POSTGRES_URL);
  db = drizzle(sql, { schema: schema });
  return db;
}
