import {
  pgTable,
  uuid,
  timestamp,
  text,
  foreignKey,
  uniqueIndex
} from 'drizzle-orm/pg-core';

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

export const slackConnections = pgTable('slack_connections', {
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
  token: text('token').notNull()
});
