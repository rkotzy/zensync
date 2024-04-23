import { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '@/lib/schema-sqlite';
import { SlackConnection } from '@/lib/schema-sqlite';
import Stripe from 'stripe';

export interface RequestInterface extends Request {
  db: DrizzleD1Database<typeof schema>;
  slackConnection: SlackConnection;
  stripeEvent: Stripe.Event;
  bodyRaw: string;
  bodyJson: any;
  bodyFormData: any;
}
