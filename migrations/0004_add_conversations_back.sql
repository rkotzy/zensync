CREATE TABLE `conversations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at_ms` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(strftime('%f', 'now') AS INTEGER) % 1000) NOT NULL,
	`updated_at_ms` integer,
	`external_id` text NOT NULL,
	`channel_id` integer NOT NULL,
	`zendesk_ticket_id` text NOT NULL,
	`follow_up_to_zendesk_ticket_id` text,
	`slack_parent_message_id` text NOT NULL,
	`slack_author_user_id` text NOT NULL,
	`latest_slack_message_id` text NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_channels_slack_connection_slack_channel_identifier`;--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_external_id_unique` ON `conversations` (`external_id`);--> statement-breakpoint
CREATE INDEX `idx_conversations_slack_parent_message_id` ON `conversations` (`slack_parent_message_id`);--> statement-breakpoint
CREATE INDEX `idx_channels_slack_connection_id` ON `channels` (`slack_connection_id`);