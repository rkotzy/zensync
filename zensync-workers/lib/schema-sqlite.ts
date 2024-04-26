import {
  sqliteTable,
  integer,
  text,
  unique,
  index
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { InferSelectModel, relations } from 'drizzle-orm';

// A Slack connection represents a connection to a Slack workspace that
// is associated to an organization. It should be initiated by a Slack
// admin whenever possible.
export const slackConnection = sqliteTable('slack_connections', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  createdAtMs: integer('created_at_ms')
    .default(
      sql`(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(strftime('%f', 'now') AS INTEGER) % 1000)`
    )
    .notNull(),
  updatedAtMs: integer('updated_at_ms'),
  slackTeamId: text('slack_team_id').notNull().unique(),
  name: text('name'),
  domain: text('domain'),
  emailDomain: text('email_domain'),
  iconUrl: text('icon_url'),
  slackEnterpriseId: text('slack_enterprise_id'),
  slackEnterpriseName: text('slack_enterprise_name'),
  encryptedToken: text('encrypted_token').notNull(),
  authedUserId: text('authed_user_id'),
  botUserId: text('bot_user_id').notNull(),
  appId: text('app_id').notNull(),
  status: text('status'),
  subscriptionId: integer('subscription_id')
    .unique()
    .references(() => subscription.id, {
      onDelete: 'no action'
    }),
  stripeCustomerId: text('stripe_customer_id'),
  supportSlackChannelId: text('support_slack_channel_id'),
  supportSlackChannelName: text('support_slack_channel_name'),
  globalSettings: text('global_settings', { mode: 'json' }).default('{}')
});

export type SlackConnection = InferSelectModel<typeof slackConnection> & {
  token: string;
  subscription?: Subscription;
};

// A Zendesk connection represents a connection to a Zendesk workspace that
// is associated to an organization. It should be Oauthed by a Slack admin
// whenever possible.
export const zendeskConnection = sqliteTable(
  'zendesk_connections',
  {
    id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
    createdAtMs: integer('created_at_ms')
      .default(
        sql`(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(strftime('%f', 'now') AS INTEGER) % 1000)`
      )
      .notNull(),
    updatedAtMs: integer('updated_at_ms'),
    slackConnectionId: integer('slack_connection_id')
      .notNull()
      .unique()
      .references(() => slackConnection.id, {
        onDelete: 'cascade'
      }),
    zendeskDomain: text('zendesk_domain').notNull(),
    zendeskEmail: text('zendesk_email').notNull(),
    encryptedZendeskApiKey: text('encrypted_zendesk_api_key').notNull(),
    zendeskTriggerId: text('zendesk_trigger_id'),
    zendeskWebhookId: text('zendesk_webhook_id').notNull(),
    hashedWebhookBearerToken: text('hashed_webhook_bearer_token').notNull(),
    encryptedZendeskSigningSecret: text('encrypted_zendesk_signing_secret'),
    status: text('status')
  },
  table => ({
    idx_zendesk_connection_webhook_id: index(
      'idx_zendesk_connection_webhook_id'
    ).on(table.zendeskWebhookId)
  })
);

export type ZendeskConnection = InferSelectModel<typeof zendeskConnection> & {
  zendeskApiKey: string;
};

// This represents a connection to a Slack channel. There can be many
// channels associated to a single Organization.
export const channel = sqliteTable(
  'channels',
  {
    id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
    createdAtMs: integer('created_at_ms')
      .default(
        sql`(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(strftime('%f', 'now') AS INTEGER) % 1000)`
      )
      .notNull(),
    updatedAtMs: integer('updated_at_ms'),
    slackChannelIdentifier: text('slack_channel_identifier').notNull(),
    slackConnectionId: integer('slack_connection_id')
      .notNull()
      .references(() => slackConnection.id, { onDelete: 'cascade' }),
    type: text('type'),
    isMember: integer('is_member', { mode: 'boolean' }),
    name: text('name'),
    isShared: integer('is_shared', { mode: 'boolean' }),
    defaultAssigneeEmail: text('default_assignee_email'),
    latestActivityAtMs: integer('latest_activity_at_ms'),
    tags: text('tags', { mode: 'json' }).$type<string[]>(),
    status: text('status'),
    globalSettingsOverrides: text('global_settings_overrides', {
      mode: 'json'
    }).default('{}')
  },
  table => ({
    channels_slack_connection_slack_channel_unique: unique().on(
      table.slackConnectionId,
      table.slackChannelIdentifier
    ),
    idx_channels_slack_connection_is_member: index(
      'idx_channels_slack_connection_is_member'
    ).on(table.slackConnectionId, table.isMember),
    idx_channels_slack_connection_slack_channel_identifier: index(
      'idx_channels_slack_connection_slack_channel_identifier'
    ).on(table.slackConnectionId, table.slackChannelIdentifier)
  })
);

export type Channel = InferSelectModel<typeof channel>;

// This represents a link between a Slack thread and a Zendesk ticket.
export const conversation = sqliteTable('conversations', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  createdAtMs: integer('created_at_ms')
    .default(
      sql`(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(strftime('%f', 'now') AS INTEGER) % 1000)`
    )
    .notNull(),
  updatedAtMs: integer('updated_at_ms'),
  externalId: text('external_id').notNull().unique(),
  channelId: integer('channel_id')
    .notNull()
    .references(() => channel.id, { onDelete: 'cascade' }),
  zendeskTicketId: text('zendesk_ticket_id').notNull(),
  followUpToZendeskTicketId: text('follow_up_to_zendesk_ticket_id'),
  slackParentMessageId: text('slack_parent_message_id').notNull(),
  slackAuthorUserId: text('slack_author_user_id').notNull()
});

export type Conversation = InferSelectModel<typeof conversation>;

export const conversationRelations = relations(conversation, ({ one }) => ({
  channel: one(channel, {
    fields: [conversation.channelId],
    references: [channel.id]
  })
}));

export const subscription = sqliteTable('subscriptions', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  createdAtMs: integer('created_at_ms')
    .default(
      sql`(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(strftime('%f', 'now') AS INTEGER) % 1000)`
    )
    .notNull(),
  updatedAtMs: integer('updated_at_ms'),
  stripeSubscriptionId: text('stripe_subscription_id').unique().notNull(),
  stripeProductId: text('stripe_product_id').notNull(),
  periodStartMs: integer('period_start_ms'),
  periodEndMs: integer('period_end_ms'),
  canceledAtMs: integer('canceled_at_ms')
});

export type Subscription = InferSelectModel<typeof subscription>;

export const slackConnectionRelations = relations(
  slackConnection,
  ({ one }) => ({
    subscription: one(subscription, {
      fields: [slackConnection.subscriptionId],
      references: [subscription.id]
    })
  })
);
