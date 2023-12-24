import { pgTable, uuid, timestamp, text } from 'drizzle-orm/pg-core';

// The organization represents a company. An organization can have many
// accounts, but a single Slack connection and Zendesk connection.
export const organization = pgTable('organizations', {
  id: uuid('id').defaultRandom().defaultRandom().primaryKey().notNull(),
  createdAt: timestamp('created_at', {
    precision: 3,
    mode: 'date',
    withTimezone: true
  })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', {
    precision: 3,
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
    precision: 3,
    mode: 'date',
    withTimezone: true
  })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', {
    precision: 3,
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
    precision: 3,
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
    precision: 3,
    mode: 'date',
    withTimezone: true
  })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', {
    precision: 3,
    mode: 'date',
    withTimezone: true
  }),
  organizationId: uuid('organization_id')
    .notNull()
    .unique()
    .references(() => organization.id, {
      onDelete: 'cascade'
    }),
  slackTeamId: text('slack_team_id').notNull(),
  name: text('name'),
  domain: text('domain'),
  emailDomain: text('email_domain'),
  iconUrl: text('icon_url'),
  slackEnterpriseId: text('slack_enterprise_id'),
  slackEnterpriseName: text('slack_enterprise_name'),
  token: text('token').notNull(),
  slackUserId: text('slack_user_id'),
  status: text('status')
});

// This represents a connection to a Slack channel. There can be many
// channels associated to a single Organization.
export const channel = pgTable('channels', {
  id: uuid('id').defaultRandom().defaultRandom().primaryKey().notNull(),
  createdAt: timestamp('created_at', {
    precision: 3,
    mode: 'date',
    withTimezone: true
  })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', {
    precision: 3,
    mode: 'date',
    withTimezone: true
  }),
  slackChannelId: text('slack_channel_id'),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  status: text('status')
});
