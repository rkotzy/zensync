import { PostHog } from 'posthog-node';
import { Env } from '@/interfaces/env.interface';

export function initializePosthog(env: Env): PostHog {
  const client = new PostHog(env.POSTHOG_ANALYTICS_KEY, {
    host: 'https://app.posthog.com',
    flushAt: 1,
    flushInterval: 0
  });
  return client;
}
