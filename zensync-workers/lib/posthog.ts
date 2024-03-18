import { PostHog } from 'posthog-node';

export function initializePosthog(env) {
  const client = new PostHog(env.POSTHOG_ANALYTICS_KEY, {
    host: 'https://app.posthog.com',
    flushAt: 1,
    flushInterval: 0
  });
  return client;
}
