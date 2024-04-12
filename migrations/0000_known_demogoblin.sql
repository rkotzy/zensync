CREATE TABLE `channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at_ms` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(strftime('%f', 'now') AS INTEGER) % 1000) NOT NULL,
	`updated_at_ms` integer,
	`slack_channel_identifier` text NOT NULL,
	`slack_connection_id` integer NOT NULL,
	`type` text,
	`is_member` integer,
	`name` text,
	`is_shared` integer,
	`default_assignee_email` text,
	`latest_activity_at_ms` integer,
	`tags` text,
	`status` text,
	`global_settings_overrides` text DEFAULT '{}',
	FOREIGN KEY (`slack_connection_id`) REFERENCES `slack_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at_ms` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(strftime('%f', 'now') AS INTEGER) % 1000) NOT NULL,
	`updated_at_ms` integer,
	`public_id` text NOT NULL,
	`channel_id` integer NOT NULL,
	`zendesk_ticket_id` text NOT NULL,
	`slack_parent_message_id` text NOT NULL,
	`slack_author_user_id` text NOT NULL,
	`latest_slack_message_id` text NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `slack_connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at_ms` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(strftime('%f', 'now') AS INTEGER) % 1000) NOT NULL,
	`updated_at_ms` integer,
	`slack_team_id` text NOT NULL,
	`name` text,
	`domain` text,
	`email_domain` text,
	`icon_url` text,
	`slack_enterprise_id` text,
	`slack_enterprise_name` text,
	`encrypted_token` text NOT NULL,
	`authed_user_id` text,
	`bot_user_id` text NOT NULL,
	`app_id` text NOT NULL,
	`status` text,
	`subscription_id` integer,
	`stripe_customer_id` text,
	`support_slack_channel_id` text,
	`support_slack_channel_name` text,
	`global_settings` text DEFAULT '{}',
	FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at_ms` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(strftime('%f', 'now') AS INTEGER) % 1000) NOT NULL,
	`updated_at_ms` integer,
	`stripe_subscription_id` text NOT NULL,
	`stripe_product_id` text NOT NULL,
	`period_start_ms` integer,
	`period_end_ms` integer,
	`canceled_at_ms` integer
);
--> statement-breakpoint
CREATE TABLE `zendesk_connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at_ms` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(strftime('%f', 'now') AS INTEGER) % 1000) NOT NULL,
	`updated_at_ms` integer,
	`slack_connection_id` integer NOT NULL,
	`zendesk_domain` text NOT NULL,
	`zendesk_email` text NOT NULL,
	`encrypted_zendesk_api_key` text NOT NULL,
	`zendesk_trigger_id` text,
	`zendesk_webhook_id` text NOT NULL,
	`hashed_webhook_bearer_token` text NOT NULL,
	`encrypted_zendesk_signing_secret` text,
	`status` text,
	FOREIGN KEY (`slack_connection_id`) REFERENCES `slack_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_channels_slack_connection_is_member` ON `channels` (`slack_connection_id`,`is_member`);--> statement-breakpoint
CREATE INDEX `idx_channels_slack_connection_slack_channel_identifier` ON `channels` (`slack_connection_id`,`slack_channel_identifier`);--> statement-breakpoint
CREATE UNIQUE INDEX `channels_slack_connection_id_slack_channel_identifier_unique` ON `channels` (`slack_connection_id`,`slack_channel_identifier`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_public_id_unique` ON `conversations` (`public_id`);--> statement-breakpoint
CREATE INDEX `idx_conversations_slack_parent_message_id` ON `conversations` (`slack_parent_message_id`);--> statement-breakpoint
CREATE INDEX `idx_conversations_channel_id` ON `conversations` (`channel_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_channel_id_zendesk_ticket_id_unique` ON `conversations` (`channel_id`,`zendesk_ticket_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_channel_id_slack_parent_message_id_unique` ON `conversations` (`channel_id`,`slack_parent_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `slack_connections_slack_team_id_unique` ON `slack_connections` (`slack_team_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `slack_connections_app_id_unique` ON `slack_connections` (`app_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `slack_connections_subscription_id_unique` ON `slack_connections` (`subscription_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_stripe_subscription_id_unique` ON `subscriptions` (`stripe_subscription_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `zendesk_connections_slack_connection_id_unique` ON `zendesk_connections` (`slack_connection_id`);