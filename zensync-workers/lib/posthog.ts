import { PostHog } from 'posthog-node';
import { Env } from '@/interfaces/env.interface';
import { convertTimestampToDate } from './utils';

export function initializePosthog(env: Env): PostHog {
  const client = new PostHog(env.POSTHOG_ANALYTICS_KEY, {
    host: 'https://app.posthog.com',
    flushAt: 1,
    flushInterval: 0
  });
  return client;
}

export async function singleEventAnalyticsLogger(
  userId: string,
  event: string,
  connectionAppId: string,
  channelId: string | null,
  timestamp: number | string | null,
  uuid: string | null,
  properties: Record<string | number, any> | null,
  env: Env | null | undefined,
  posthog: PostHog | null | undefined
): Promise<void> {
  let client = posthog;
  if (!client) {
    client = initializePosthog(env);
  }

  if (!userId) {
    userId = 'static_string_for_group_events';
  }

  let dateTimestamp: Date | null = null;
  if (typeof timestamp === 'number' || typeof timestamp === 'string') {
    dateTimestamp = convertTimestampToDate(timestamp);
  }

  client.capture({
    timestamp: dateTimestamp,
    uuid: uuid,
    distinctId: userId,
    event: event,
    groups: { company: connectionAppId, channel: channelId },
    properties: properties
  });

  await client.shutdown();
}
