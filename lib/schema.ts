import {
  pgTable,
  uuid,
  timestamp,
  text,
  pgEnum,
  unique
} from 'drizzle-orm/pg-core';
import { InferSelectModel } from 'drizzle-orm';

// The organization represents a company. An organization can have many
// accounts, but a single Slack connection and Zendesk connection.
export const organization = pgTable('organizations', {
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
  name: text('name').notNull()
});

// An account represents a user in the system. An account can belong to
// one or more organizations.
export const account = pgTable('accounts', {
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
  name: text('name').notNull()
});

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
    .notNull(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => account.id, { onDelete: 'cascade' })
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
  organizationId: uuid('organization_id')
    .notNull()
    .unique()
    .references(() => organization.id, {
      onDelete: 'cascade'
    }),
  slackTeamId: text('slack_team_id').notNull().unique(),
  name: text('name'),
  domain: text('domain'),
  emailDomain: text('email_domain'),
  iconUrl: text('icon_url'),
  slackEnterpriseId: text('slack_enterprise_id'),
  slackEnterpriseName: text('slack_enterprise_name'),
  token: text('token').notNull(),
  authedUserId: text('authed_user_id'),
  botUserId: text('bot_user_id').notNull(),
  status: text('status')
});

export type SlackConnection = InferSelectModel<typeof slackConnection>;

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
  organizationId: uuid('organization_id')
    .notNull()
    .unique()
    .references(() => organization.id, {
      onDelete: 'cascade'
    }),
  zendeskDomain: text('zendesk_domain').notNull(),
  zendeskEmail: text('zendesk_email').notNull(),
  zendeskApiKey: text('zendesk_api_key').notNull(),
  status: text('status')
});

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
    slackChannelId: text('slack_channel_id').notNull(),
    slackChannelType: text('slack_channel_type'),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    status: text('status')
  },
  table => ({
    channels_organization_slack_channel_unique: unique().on(
      table.organizationId,
      table.slackChannelId
    )
  })
);

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
    slackAuthorUserId: text('slack_author_user_id').notNull()
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

// This represents the actual messages that are sent in either
// Slack or Zendesk.
export const messageTypeEnum = pgEnum('message_type_enum', [
  'SLACK',
  'ZENDESK'
]);
export const message = pgTable(
  'messages',
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
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    type: messageTypeEnum('type').notNull(),
    platformIdentifier: text('platform_identifier').notNull()
  },
  table => ({
    messages_type_platform_identifier_unique: unique().on(
      table.conversationId,
      table.type,
      table.platformIdentifier
    )
  })
);
