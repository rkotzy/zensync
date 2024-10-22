import { DrizzleD1Database, drizzle } from 'drizzle-orm/d1';
import { eq, and, asc, isNull, gt, lte, desc } from 'drizzle-orm';
import * as schema from './schema-sqlite';
import {
  slackConnection,
  SlackConnection,
  zendeskConnection,
  ZendeskConnection,
  channel,
  Channel,
  subscription,
  conversation
} from './schema-sqlite';
import { Env } from '@/interfaces/env.interface';
import { importEncryptionKeyFromEnvironment, decryptData } from './encryption';
import { SlackTeam } from '@/interfaces/slack-api.interface';
import {
  GlobalSettingDefaults,
  GlobalSettings
} from '@/interfaces/global-settings.interface';
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
  searchKey: 'teamId',
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
  } else if (searchKey === 'teamId') {
    whereCondition = eq(slackConnection.slackTeamId, searchValue);
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
        updatedAtMs: new Date().getTime(),
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
      hashedWebhookBearerToken: zendeskConnectionCreate.hashedWebhookToken,
      encryptedZendeskSigningSecret:
        zendeskConnectionCreate.encryptedZendeskSigningSecret
    })
    .onConflictDoUpdate({
      target: zendeskConnection.slackConnectionId,
      set: {
        updatedAtMs: new Date().getTime(),
        encryptedZendeskApiKey: zendeskConnectionCreate.encryptedApiKey,
        zendeskDomain: zendeskConnectionCreate.zendeskDomain,
        zendeskEmail: zendeskConnectionCreate.zendeskEmail,
        hashedWebhookBearerToken: zendeskConnectionCreate.hashedWebhookToken,
        zendeskTriggerId: zendeskConnectionCreate.zendeskTriggerId,
        zendeskWebhookId: zendeskConnectionCreate.zendeskWebhookId,
        status: 'ACTIVE',
        encryptedZendeskSigningSecret:
          zendeskConnectionCreate.encryptedZendeskSigningSecret
      }
    });
}

export async function updateZendeskConnection(
  db: DrizzleD1Database<typeof schema>,
  slackConnectionId: number,
  zendeskDomain: string,
  zendeskEmail: string,
  encryptedApiKey: string
) {
  await db
    .update(zendeskConnection)
    .set({
      updatedAtMs: new Date().getTime(),
      zendeskDomain: zendeskDomain,
      zendeskEmail: zendeskEmail,
      encryptedZendeskApiKey: encryptedApiKey
    })
    .where(eq(zendeskConnection.slackConnectionId, slackConnectionId));
}

export async function getChannels(
  db: DrizzleD1Database<typeof schema>,
  slackConnectionId: number,
  limit?: number | null
) {
  return await db.query.channel.findMany({
    where: and(
      eq(channel.slackConnectionId, slackConnectionId),
      eq(channel.isMember, true)
    ),
    orderBy: [asc(channel.createdAtMs)],
    limit: limit ? limit : 1000
  });
}

export async function getChannel(
  db: DrizzleD1Database<typeof schema>,
  slackConnectionId: number,
  slackChannelIdentifier: string
): Promise<Channel | null> {
  return await db.query.channel.findFirst({
    where: and(
      eq(channel.slackConnectionId, slackConnectionId),
      eq(channel.slackChannelIdentifier, slackChannelIdentifier)
    )
  });
}

export async function createOrUpdateChannel(
  db: DrizzleD1Database<typeof schema>,
  slackConnectionId: number,
  slackChannelIdentifier: string,
  slackChannelType: string,
  slackChannelName: string,
  isShared: boolean,
  status: string
) {
  await db
    .insert(channel)
    .values({
      slackConnectionId: slackConnectionId,
      slackChannelIdentifier: slackChannelIdentifier,
      type: slackChannelType,
      isMember: true,
      name: slackChannelName,
      isShared: isShared,
      status: status
    })
    .onConflictDoUpdate({
      target: [channel.slackConnectionId, channel.slackChannelIdentifier],
      set: {
        updatedAtMs: new Date().getTime(),
        type: slackChannelType,
        isMember: true,
        name: slackChannelName,
        isShared: isShared,
        status: status
      }
    });
}

export async function updateChannelSettings(
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

export async function updateDefaultChannelSettings(
  db: DrizzleD1Database<typeof schema>,
  slackConnectionId: number,
  defaultAssigneeEmail: string | null,
  defaultTags: string[],
  sameSenderTimeframe: number
) {
  const updatedSettings: GlobalSettings = {
    defaultZendeskAssignee: defaultAssigneeEmail,
    defaultZendeskTags: defaultTags,
    sameSenderTimeframe: sameSenderTimeframe,
    removeZendeskSignatures: GlobalSettingDefaults.removeZendeskSignatures
  };

  await db
    .update(slackConnection)
    .set({
      globalSettings: updatedSettings
    })
    .where(eq(slackConnection.id, slackConnectionId));
}

export async function createSubscription(
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  stripeSubscriptionId: string,
  currentPeriodStartTimestamp: number,
  currentPeriodEndTimestamp: number
) {
  return await db
    .insert(subscription)
    .values({
      stripeSubscriptionId: stripeSubscriptionId,
      stripeProductId: env.DEFAULT_STRIPE_PRODUCT_ID,
      periodStartMs: currentPeriodStartTimestamp * 1000,
      periodEndMs: currentPeriodEndTimestamp * 1000
    })
    .onConflictDoNothing()
    .returning();
}

export async function attachSubscriptionToSlackConnection(
  db: DrizzleD1Database<typeof schema>,
  slackConnectionId: number,
  subscriptionId: number,
  stripeCustomerId: string
) {
  await db
    .update(slackConnection)
    .set({
      stripeCustomerId: stripeCustomerId,
      subscriptionId: subscriptionId
    })
    .where(eq(slackConnection.id, slackConnectionId));
}

export async function updateStripeSubscriptionId(
  db: DrizzleD1Database<typeof schema>,
  stripeSubscriptionId: string,
  eventCreatedMs: number,
  currentPeriodStartMs: number,
  currentPeriodEndMs: number,
  canceledAtMs: number | null,
  productId: string | null
) {
  await db
    .update(subscription)
    .set({
      updatedAtMs: eventCreatedMs,
      periodStartMs: currentPeriodStartMs,
      periodEndMs: currentPeriodEndMs,
      canceledAtMs: canceledAtMs,
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

export async function updateChannelActivity(
  slackConnection: SlackConnection,
  channelId: string,
  db: DrizzleD1Database<typeof schema>
): Promise<void> {
  const now = new Date().getTime();

  await db
    .update(channel)
    .set({
      updatedAtMs: now,
      latestActivityAtMs: now
    })
    .where(
      and(
        eq(channel.slackConnectionId, slackConnection.id),
        eq(channel.slackChannelIdentifier, channelId)
      )
    );
}

export async function leaveAllChannels(
  db: DrizzleD1Database<typeof schema>,
  connectionId: number
) {
  await db
    .update(channel)
    .set({ isMember: false, updatedAtMs: new Date().getTime() })
    .where(
      and(
        eq(channel.slackConnectionId, connectionId),
        eq(channel.isMember, true)
      )
    );
}

export async function updateChannelMembership(
  db: DrizzleD1Database<typeof schema>,
  slackConnectionId: number,
  slackChannelIdentifier: string,
  isMember: boolean
) {
  await db
    .update(channel)
    .set({
      updatedAtMs: new Date().getTime(),
      isMember: isMember
    })
    .where(
      and(
        eq(channel.slackConnectionId, slackConnectionId),
        eq(channel.slackChannelIdentifier, slackChannelIdentifier)
      )
    );
}

export async function updateChannelName(
  db: DrizzleD1Database<typeof schema>,
  slackConnectionId: number,
  slackChannelIdentifier: string,
  newChannelName: string
) {
  await db
    .update(channel)
    .set({
      updatedAtMs: new Date().getTime(),
      name: newChannelName
    })
    .where(
      and(
        eq(channel.slackConnectionId, slackConnectionId),
        eq(channel.slackChannelIdentifier, slackChannelIdentifier)
      )
    );
}

export async function updateChannelIdentifier(
  db: DrizzleD1Database<typeof schema>,
  slackConnectionId: number,
  oldChannelIdentifier: string,
  newChannelIdentifier: string
) {
  await db
    .update(channel)
    .set({
      updatedAtMs: new Date().getTime(),
      slackChannelIdentifier: newChannelIdentifier
    })
    .where(
      and(
        eq(channel.slackConnectionId, slackConnectionId),
        eq(channel.slackChannelIdentifier, oldChannelIdentifier)
      )
    );
}

export async function deactivateChannels(
  db: DrizzleD1Database<typeof schema>,
  connectionId: number,
  beyondTimestampMs: number
) {
  return await db
    .update(channel)
    .set({ status: 'PENDING_UPGRADE', updatedAtMs: new Date().getTime() })
    .where(
      and(
        eq(channel.slackConnectionId, connectionId),
        eq(channel.isMember, true),
        isNull(channel.status),
        gt(channel.createdAtMs, beyondTimestampMs)
      )
    )
    .returning();
}

export async function activateChannels(
  db: DrizzleD1Database<typeof schema>,
  connectionId: number,
  upToTimestampMs: number
) {
  return await db
    .update(channel)
    .set({ status: null, updatedAtMs: new Date().getTime() })
    .where(
      and(
        eq(channel.slackConnectionId, connectionId),
        eq(channel.isMember, true),
        eq(channel.status, 'PENDING_UPGRADE'),
        lte(channel.createdAtMs, upToTimestampMs)
      )
    )
    .returning();
}

export async function activateAllChannels(
  db: DrizzleD1Database<typeof schema>,
  connectionId: number
) {
  await db
    .update(channel)
    .set({ status: null, updatedAtMs: new Date().getTime() })
    .where(
      and(
        eq(channel.slackConnectionId, connectionId),
        eq(channel.isMember, true),
        eq(channel.status, 'PENDING_UPGRADE')
      )
    );
}

export async function saveSharedSlackChannel(
  db: DrizzleD1Database<typeof schema>,
  slackConnectionInfo: SlackConnection,
  slackChannelIdentifier: string
) {
  await db
    .update(slackConnection)
    .set({
      supportSlackChannelId: slackChannelIdentifier,
      supportSlackChannelName: `ext-zensync-${slackConnectionInfo.domain}`
    })
    .where(eq(slackConnection.id, slackConnectionInfo.id));
}

export async function getZendeskCredentialsFromWebhookId(
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  webhookId: string,
  key?: CryptoKey
): Promise<ZendeskConnection | null | undefined> {
  try {
    const zendeskCredentials = await db.query.zendeskConnection.findFirst({
      where: eq(zendeskConnection.zendeskWebhookId, webhookId)
    });

    const zendeskDomain = zendeskCredentials?.zendeskDomain;
    const zendeskEmail = zendeskCredentials?.zendeskEmail;
    const encryptedZendeskApiKey = zendeskCredentials?.encryptedZendeskApiKey;

    if (!zendeskDomain || !zendeskEmail || !encryptedZendeskApiKey) {
      safeLog(
        'log',
        `No Zendesk credentials found for webhook Id ${webhookId}`
      );
      return null;
    }

    let encryptionKey = key;
    if (!encryptionKey) {
      encryptionKey = await importEncryptionKeyFromEnvironment(env);
    }
    const decryptedApiKey = await decryptData(
      encryptedZendeskApiKey,
      encryptionKey
    );

    return {
      ...zendeskCredentials,
      zendeskApiKey: decryptedApiKey
    };
  } catch (error) {
    safeLog('error', `Error querying ZendeskConnections: ${error}`);
    return undefined;
  }
}

export async function getZendeskCredentials(
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  slackConnectionId: number,
  key?: CryptoKey
): Promise<ZendeskConnection | null | undefined> {
  try {
    const zendeskCredentials = await db.query.zendeskConnection.findFirst({
      where: eq(zendeskConnection.slackConnectionId, slackConnectionId)
    });
    const zendeskDomain = zendeskCredentials?.zendeskDomain;
    const zendeskEmail = zendeskCredentials?.zendeskEmail;
    const encryptedZendeskApiKey = zendeskCredentials?.encryptedZendeskApiKey;

    if (!zendeskDomain || !zendeskEmail || !encryptedZendeskApiKey) {
      safeLog(
        'log',
        `No Zendesk credentials found for slack connection ${slackConnectionId}`
      );
      return null;
    }

    let encryptionKey = key;
    if (!encryptionKey) {
      encryptionKey = await importEncryptionKeyFromEnvironment(env);
    }
    const decryptedApiKey = await decryptData(
      encryptedZendeskApiKey,
      encryptionKey
    );

    return {
      ...zendeskCredentials,
      zendeskApiKey: decryptedApiKey
    };
  } catch (error) {
    safeLog('error', `Error querying ZendeskConnections: ${error}`);
    return undefined;
  }
}

export async function getConversationFromExternalId(
  db: DrizzleD1Database<typeof schema>,
  slackConnectionId: number,
  externalId: string
) {
  const conversationInfo = await db
    .select({ conversation, channel })
    .from(conversation)
    .innerJoin(channel, eq(conversation.channelId, channel.id))
    .where(
      and(
        eq(channel.slackConnectionId, slackConnectionId),
        eq(conversation.externalId, externalId)
      )
    )
    .limit(1);

  if (!conversationInfo || conversationInfo.length === 0) {
    return null;
  }

  return conversationInfo[0];
}

export async function getConversationFromSlackMessage(
  db: DrizzleD1Database<typeof schema>,
  slackConnectionId: number,
  slackChannelIdentifier: string,
  slackParentMessageId: string
) {
  const conversationInfo = await db
    .select({ conversation, channel })
    .from(conversation)
    .innerJoin(channel, eq(conversation.channelId, channel.id))
    .where(
      and(
        eq(channel.slackConnectionId, slackConnectionId),
        eq(channel.slackChannelIdentifier, slackChannelIdentifier),
        eq(conversation.slackParentMessageId, slackParentMessageId)
      )
    )
    .orderBy(desc(conversation.createdAtMs))
    .limit(1);

  if (!conversationInfo || conversationInfo.length === 0) {
    return null;
  }

  return conversationInfo[0];
}

export async function getLatestConversationInChannel(
  db: DrizzleD1Database<typeof schema>,
  slackConnectionId: number,
  channelIdentifier: string
) {
  const conversationInfo = await db
    .select({ conversation, channel })
    .from(conversation)
    .innerJoin(channel, eq(conversation.channelId, channel.id))
    .where(
      and(
        eq(channel.slackConnectionId, slackConnectionId),
        eq(channel.slackChannelIdentifier, channelIdentifier)
      )
    )
    .orderBy(desc(conversation.createdAtMs))
    .limit(1);

  if (!conversationInfo || conversationInfo.length === 0) {
    return null;
  }

  return conversationInfo[0];
}

export async function updateLatestSlackMessageId(
  db: DrizzleD1Database<typeof schema>,
  conversationId: number,
  slackMessageId: string
) {
  await db
    .update(conversation)
    .set({
      latestSlackMessageId: slackMessageId
    })
    .where(eq(conversation.id, conversationId));
}

export async function createConversation(
  db: DrizzleD1Database<typeof schema>,
  externalId: string,
  channelId: number,
  slackParentMessageId: string,
  zendeskTicketId: string,
  slackAuthorUserId: string,
  followUpToZendeskTicketId?: string
) {
  await db.insert(conversation).values({
    externalId: externalId,
    channelId: channelId,
    slackParentMessageId: slackParentMessageId,
    zendeskTicketId: zendeskTicketId,
    slackAuthorUserId: slackAuthorUserId,
    followUpToZendeskTicketId: followUpToZendeskTicketId,
    latestSlackMessageId: slackParentMessageId
  });
}
