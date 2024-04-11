import { DrizzleD1Database, drizzle } from 'drizzle-orm/d1';
import { eq, and } from 'drizzle-orm';
import * as schema from './schema-sqlite';
import {
  slackConnection,
  SlackConnection,
  zendeskConnection,
  channel,
  subscription,
  conversation
} from './schema-sqlite';
import { Env } from '@/interfaces/env.interface';
import { importEncryptionKeyFromEnvironment, decryptData } from './encryption';
import { SlackTeam } from '@/interfaces/slack-api.interface';
import { GlobalSettingDefaults } from '@/interfaces/global-settings.interface';
import { ZendeskConnectionCreate } from '@/interfaces/zendesk-api.interface';
import { safeLog } from './logging';

export function initializeDb(env: Env) {
  const db = drizzle(env.DBSQLITE, { schema: schema });
  return db;
}

export async function getSlackConnection(
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  searchKey: 'id',
  searchValue: number
): Promise<SlackConnection | null | undefined>;

export async function getSlackConnection(
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  searchKey: 'appId',
  searchValue: string
): Promise<SlackConnection | null | undefined>;

export async function getSlackConnection(
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  searchKey: any,
  searchValue: any
): Promise<SlackConnection | null | undefined> {
  let whereCondition;

  if (searchKey === 'id') {
    whereCondition = eq(slackConnection.id, searchValue);
  } else if (searchKey === 'appId') {
    whereCondition = eq(slackConnection.appId, searchValue);
  } else {
    throw new Error('Invalid search key');
  }

  const connection = await db.query.slackConnection.findFirst({
    where: whereCondition,
    with: {
      subscription: true
    }
  });

  if (connection) {
    const encryptionKey = await importEncryptionKeyFromEnvironment(env);
    const decryptedToken = await decryptData(
      connection.encryptedToken,
      encryptionKey
    );

    return { ...connection, token: decryptedToken };
  }

  return null;
}

export async function getSlackConnectionFromStripeSubscription(
  db: DrizzleD1Database<typeof schema>,
  stripeSubscriptionId: string
) {
  const slackConnectionInfo = await db
    .select()
    .from(slackConnection)
    .fullJoin(subscription, eq(slackConnection.subscriptionId, subscription.id))
    .where(eq(subscription.stripeSubscriptionId, stripeSubscriptionId))
    .limit(1);

  if (!slackConnectionInfo[0]) {
    safeLog('error', `Subscription not found: ${stripeSubscriptionId}`);
    throw new Error(`Subscription not found: ${stripeSubscriptionId}`);
  }

  return slackConnectionInfo[0];
}

export async function createOrUpdateSlackConnection(
  db: DrizzleD1Database<typeof schema>,
  team: SlackTeam,
  authedUserId: string,
  botUserId: string,
  appId: string,
  encryptedToken: string
): Promise<Record<string, any>> {
  return await db
    .insert(slackConnection)
    .values({
      slackTeamId: team.id,
      name: team.name,
      domain: team.domain,
      iconUrl: team.icon.image_132,
      emailDomain: team.email_domain,
      slackEnterpriseId: team.enterprise_id,
      slackEnterpriseName: team.enterprise_name,
      encryptedToken: encryptedToken,
      authedUserId: authedUserId,
      botUserId: botUserId,
      appId: appId,
      status: 'ACTIVE',
      globalSettings: GlobalSettingDefaults
    })
    .onConflictDoUpdate({
      target: slackConnection.slackTeamId,
      set: {
        updatedAt: new Date().toISOString(),
        name: team.name,
        domain: team.domain,
        iconUrl: team.icon.image_132,
        emailDomain: team.email_domain,
        slackEnterpriseId: team.enterprise_id,
        slackEnterpriseName: team.enterprise_name,
        encryptedToken: encryptedToken,
        authedUserId: authedUserId,
        botUserId: botUserId,
        appId: appId,
        status: 'ACTIVE'
      }
    })
    .returning();
}

export async function createOrUpdateZendeskConnection(
  db: DrizzleD1Database<typeof schema>,
  zendeskConnectionCreate: ZendeskConnectionCreate
) {
  await db
    .insert(zendeskConnection)
    .values({
      encryptedZendeskApiKey: zendeskConnectionCreate.encryptedApiKey,
      zendeskDomain: zendeskConnectionCreate.zendeskDomain,
      zendeskEmail: zendeskConnectionCreate.zendeskEmail,
      slackConnectionId: zendeskConnectionCreate.slackConnectionId,
      status: 'ACTIVE',
      zendeskTriggerId: zendeskConnectionCreate.zendeskTriggerId,
      zendeskWebhookId: zendeskConnectionCreate.zendeskWebhookId,
      hashedWebhookBearerToken: zendeskConnectionCreate.hashedWebhookToken
    })
    .onConflictDoUpdate({
      target: zendeskConnection.slackConnectionId,
      set: {
        updatedAt: new Date().toISOString(),
        encryptedZendeskApiKey: zendeskConnectionCreate.encryptedApiKey,
        zendeskDomain: zendeskConnectionCreate.zendeskDomain,
        zendeskEmail: zendeskConnectionCreate.zendeskEmail,
        hashedWebhookBearerToken: zendeskConnectionCreate.hashedWebhookToken,
        zendeskTriggerId: zendeskConnectionCreate.zendeskTriggerId,
        zendeskWebhookId: zendeskConnectionCreate.zendeskWebhookId,
        status: 'ACTIVE'
      }
    });
}

export async function getChannels(
  db: DrizzleD1Database<typeof schema>,
  slackConnectionId: number,
  isMember?: boolean | null,
  limit?: number | null
) {
  return await db
    .select({ id: channel.id })
    .from(channel)
    .where(
      and(
        eq(channel.slackConnectionId, slackConnectionId),
        isMember ? eq(channel.isMember, isMember) : undefined
      )
    )
    .limit(limit ? limit : 1000);
}

export async function getChannel(
  db: DrizzleD1Database<typeof schema>,
  slackConnectionId: number,
  slackChannelIdentifier: string
) {
  return await db.query.channel.findFirst({
    where: and(
      eq(channel.slackConnectionId, slackConnectionId),
      eq(channel.slackChannelIdentifier, slackChannelIdentifier)
    )
  });
}

export async function updateChannel(
  db: DrizzleD1Database<typeof schema>,
  slackConnectionId: number,
  slackChannelIdentifier: string,
  channelOwnerEmail: string | null,
  tagsArray: string[]
) {
  await db
    .update(channel)
    .set({
      defaultAssigneeEmail: channelOwnerEmail ?? null,
      tags: tagsArray
    })
    .where(
      and(
        eq(channel.slackConnectionId, slackConnectionId),
        eq(channel.slackChannelIdentifier, slackChannelIdentifier)
      )
    );
}

export async function updateStripeSubscriptionId(
  db: DrizzleD1Database<typeof schema>,
  stripeSubscriptionId: string,
  eventCreatedTimestamp: number,
  currentPeriodStart: string,
  currentPeriodEnd: string,
  canceledAt: string | null,
  productId: string | null
) {
  await db
    .update(subscription)
    .set({
      updatedAt: new Date(eventCreatedTimestamp * 1000).toISOString(),
      periodStart: currentPeriodStart,
      periodEnd: currentPeriodEnd,
      canceledAt: canceledAt,
      ...(productId ? { stripeProductId: productId } : {})
    })
    .where(eq(subscription.stripeSubscriptionId, stripeSubscriptionId));
}

export async function getSubscription(
  db: DrizzleD1Database<typeof schema>,
  stripSubscriptionId: string
) {
  return await db.query.subscription.findFirst({
    where: eq(subscription.stripeSubscriptionId, stripSubscriptionId)
  });
}

export async function getConversation(
  db: DrizzleD1Database<typeof schema>,
  publicId: string
) {
  return await db.query.conversation.findFirst({
    where: eq(conversation.publicId, publicId),
    with: {
      channel: true
    }
  });
}
