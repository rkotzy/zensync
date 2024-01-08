// drizzle.config.ts
import type { Config } from 'drizzle-kit';
export default {
  schema: './lib/schema.ts',
  out: './migrations',
  driver: 'pg',
  dbCredentials: {
    connectionString: process.env.POSTGRES_URL! + '?sslmode=require'
  }
} satisfies Config;
