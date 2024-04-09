import {
  pgTable,
  uuid,
  timestamp,
  text,
  boolean,
  jsonb,
  unique,
  index,
  numeric
} from 'drizzle-orm/pg-core';
import { InferSelectModel, relations } from 'drizzle-orm';

// A Slack connection represents a connection to a Slack workspace that
// is associated to an organization. It should be initiated by a Slack
// admin whenever possible.
export const slackConnection = pgTable('slack_connections', {
  id: uuid('id').defaultRandom().primaryKey().notNull(),
  createdAt: timestamp('created_at', {
    mode: 'date',
    withTimezone: true,
    precision: 3
  })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', {
    mode: 'date',
    withTimezone: true,
    precision: 3
  }),
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
  appId: text('app_id').notNull().unique(),
  status: text('status'),
  subscriptionId: uuid('subscription_id')
    .unique()
    .references(() => subscription.id, {
      onDelete: 'no action'
    }),
  stripeCustomerId: text('stripe_customer_id'),
  supportSlackChannelId: text('support_slack_channel_id'),
  supportSlackChannelName: text('support_slack_channel_name'),
  globalSettings: jsonb('global_settings').notNull().default('{}')
});

export type SlackConnection = InferSelectModel<typeof slackConnection> & {
  token: string;
  subscription?: Subscription;
};

// A Zendesk connection represents a connection to a Zendesk workspace that
// is associated to an organization. It should be Oauthed by a Slack admin
// whenever possible.
export const zendeskConnection = pgTable('zendesk_connections', {
  id: uuid('id').defaultRandom().primaryKey().notNull(),
  createdAt: timestamp('created_at', {
    mode: 'date',
    withTimezone: true,
    precision: 3
  })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', {
    mode: 'date',
    withTimezone: true,
    precision: 3
  }),
  slackConnectionId: uuid('slack_connection_id')
    .notNull()
    .unique()
    .references(() => slackConnection.id, {
      onDelete: 'cascade'
    }),
  zendeskDomain: text('zendesk_domain').notNull(),
  zendeskEmail: text('zendesk_email').notNull(),
  encryptedZendeskApiKey: text('encrypted_zendesk_api_key').notNull(),
  zendeskTriggerId: text('zendesk_trigger_id'),
  zendeskWebhookId: text('zendesk_webhook_id'),
  hashedWebhookBearerToken: text('hashed_webhook_bearer_token'),
  status: text('status')
});

export type ZendeskConnection = InferSelectModel<typeof zendeskConnection> & {
  zendeskApiKey: string;
};

// This represents a connection to a Slack channel. There can be many
// channels associated to a single Organization.
export const channel = pgTable(
  'channels',
  {
    id: uuid('id').defaultRandom().primaryKey().notNull(),
    createdAt: timestamp('created_at', {
      mode: 'date',
      withTimezone: true,
      precision: 3
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      mode: 'date',
      withTimezone: true,
      precision: 3
    }),
    slackChannelIdentifier: text('slack_channel_identifier').notNull(),
    slackConnectionId: uuid('slack_connection_id')
      .notNull()
      .references(() => slackConnection.id, { onDelete: 'cascade' }),
    type: text('type'),
    isMember: boolean('is_member'),
    name: text('name'),
    isShared: boolean('is_shared'),
    defaultAssigneeEmail: text('default_assignee_email'),
    latestActivityAt: timestamp('latest_activity_at', {
      mode: 'date',
      withTimezone: true,
      precision: 3
    }),
    tags: text('tags').array(),
    status: text('status'),
    globalSettingsOverrides: jsonb('global_settings_overrides')
  },
  table => ({
    channels_slack_connection_slack_channel_unique: unique().on(
      table.slackConnectionId,
      table.slackChannelIdentifier
    ),
    idx_channels_slack_connection_is_member: index().on(
      table.slackConnectionId,
      table.isMember
    )
  })
);

export type Channel = InferSelectModel<typeof channel>;

// This represents a link between a Slack thread and a Zendesk ticket.
export const conversation = pgTable(
  'conversations',
  {
    id: uuid('id').defaultRandom().primaryKey().notNull(),
    createdAt: timestamp('created_at', {
      mode: 'date',
      withTimezone: true,
      precision: 3
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      mode: 'date',
      withTimezone: true,
      precision: 3
    }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channel.id, { onDelete: 'cascade' }),
    zendeskTicketId: text('zendesk_ticket_id').notNull(),
    slackParentMessageId: text('slack_parent_message_id').notNull(),
    slackParentMessageTs: numeric('slack_parent_message_ts', {
      precision: 8
    }),
    slackAuthorUserId: text('slack_author_user_id').notNull(),
    latestSlackMessageId: text('latest_slack_message_id').notNull()
  },
  table => ({
    conversations_channel_zendesk_ticket_unique: unique().on(
      table.channelId,
      table.zendeskTicketId
    ),
    conversations_channel_slack_message_unique: unique().on(
      table.channelId,
      table.slackParentMessageId
    )
  })
);

export type Conversation = InferSelectModel<typeof conversation>;

export const conversationRelations = relations(conversation, ({ one }) => ({
  channel: one(channel, {
    fields: [conversation.channelId],
    references: [channel.id]
  })
}));

export const subscription = pgTable('subscriptions', {
  id: uuid('id').defaultRandom().primaryKey().notNull(),
  createdAt: timestamp('created_at', {
    mode: 'date',
    withTimezone: true,
    precision: 3
  })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', {
    mode: 'date',
    withTimezone: true,
    precision: 3
  }),
  stripeSubscriptionId: text('stripe_subscription_id').unique().notNull(),
  stripeProductId: text('stripe_product_id').notNull(),
  periodStart: timestamp('period_start', {
    mode: 'date',
    withTimezone: true
  }),
  periodEnd: timestamp('period_end', {
    mode: 'date',
    withTimezone: true
  }),
  canceledAt: timestamp('canceled_at', {
    mode: 'date',
    withTimezone: true
  })
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
