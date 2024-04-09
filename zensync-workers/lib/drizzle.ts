import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import * as schema from './schema';
import { Env } from '@/interfaces/env.interface';

export function initializeDb(env: Env) {
  const sql = neon(env.HYPERDRIVE.connectionString);
  const db = drizzle(sql, { schema: schema });
  return db;
}
