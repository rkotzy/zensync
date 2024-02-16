import { OpenAPIRoute } from '@cloudflare/itty-router-openapi';
import { initializeDb } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import {
  zendeskConnection,
  SlackConnection,
  slackConnection,
  conversation
} from '@/lib/schema';
import * as schema from '@/lib/schema';
import { SlackResponse } from '@/interfaces/slack-api.interface';
import { ZendeskEvent } from '@/interfaces/zendesk-api.interface';
import { Logtail } from '@logtail/edge';
import { EdgeWithExecutionContext } from '@logtail/edge/dist/es6/edgeWithExecutionContext';
import { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { Env } from '@/interfaces/env.interface';
import { getSlackConnection } from '@/lib/utils';
import bcrypt from 'bcryptjs';
import Stripe from 'stripe';

export class StripeEventHandler extends OpenAPIRoute {
  async handle(
    request: Request,
    env: Env,
    context: any,
    data: Record<string, any>
  ) {
    return new Response('Ok', { status: 200 });
  }
}