// drizzle.config.ts
import type { Config } from 'drizzle-kit';
export default {
  schema: './zensync-workers/lib/schema-sqlite.ts',
  out: './migrations',
  driver: 'd1'
} satisfies Config;
