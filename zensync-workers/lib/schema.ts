import {
  pgTable,
  uuid,
  timestamp,
  text,
  boolean,
  pgEnum,
  unique,
  index
} from 'drizzle-orm/pg-core';
import { InferSelectModel, relations } from 'drizzle-orm';

// This table stores the state parameter that is passed to the Slack OAuth.
// This is used to prevent CSRF attacks and is a temporary value. We can
// delete any values beyond a certain age (e.g. 10 minutes) safely.
export const slackOauthState = pgTable('slack_oauth_states', {
  id: uuid('id').primaryKey().notNull(),
  createdAt: timestamp('created_at', {
    mode: 'date',
    withTimezone: true
  })
    .defaultNow()
    .notNull()
});

// A Slack connection represents a connection to a Slack workspace that
// is associated to an organization. It should be initiated by a Slack
// admin whenever possible.
export const slackConnection = pgTable('slack_connections', {
  id: uuid('id').defaultRandom().primaryKey().notNull(),
  createdAt: timestamp('created_at', {
    mode: 'date',
    withTimezone: true
  })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', {
    mode: 'date',
    withTimezone: true
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
  status: text('status')
});

export type SlackConnection = InferSelectModel<typeof slackConnection> & {
  token: string;
};

// A Zendesk connection represents a connection to a Zendesk workspace that
// is associated to an organization. It should be Oauthed by a Slack admin
// whenever possible.
export const zendeskConnection = pgTable('zendesk_connections', {
  id: uuid('id').defaultRandom().primaryKey().notNull(),
  createdAt: timestamp('created_at', {
    mode: 'date',
    withTimezone: true
  })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', {
    mode: 'date',
    withTimezone: true
  }),
  slackConnectionId: uuid('slack_connection_id')
    .notNull()
    .unique()
    .references(() => slackConnection.id, {
      onDelete: 'cascade'
    }),
  zendeskDomain: text('zendesk_domain').notNull(),
  zendeskEmail: text('zendesk_email').notNull(),
  zendeskApiKey: text('zendesk_api_key').notNull(),
  zendeskTriggerId: text('zendesk_trigger_id'),
  zendeskWebhookId: text('zendesk_webhook_id'),
  webhookBearerToken: text('webhook_bearer_token').unique(),
  status: text('status')
});

export type ZendeskConnection = InferSelectModel<typeof zendeskConnection>;

// This represents a connection to a Slack channel. There can be many
// channels associated to a single Organization.
export const channel = pgTable(
  'channels',
  {
    id: uuid('id').defaultRandom().defaultRandom().primaryKey().notNull(),
    createdAt: timestamp('created_at', {
      mode: 'date',
      withTimezone: true
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      mode: 'date',
      withTimezone: true
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
      withTimezone: true
    }),
    tags: text('tags').array()
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
    id: uuid('id').defaultRandom().defaultRandom().primaryKey().notNull(),
    createdAt: timestamp('created_at', {
      mode: 'date',
      withTimezone: true
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      mode: 'date',
      withTimezone: true
    }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channel.id, { onDelete: 'cascade' }),
    zendeskTicketId: text('zendesk_ticket_id').notNull(),
    slackParentMessageId: text('slack_parent_message_id').notNull(),
    slackAuthorUserId: text('slack_author_user_id').notNull(),
    latestSlackMessageId: text('latest_slack_message_id')
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

export const conversationRelations = relations(conversation, ({ one }) => ({
  channel: one(channel, {
    fields: [conversation.channelId],
    references: [channel.id]
  })
}));
