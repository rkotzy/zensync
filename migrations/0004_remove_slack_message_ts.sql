DROP INDEX IF EXISTS `idx_conversations_slack_parent_message_ts`;--> statement-breakpoint
CREATE INDEX `idx_conversations_slack_parent_message_id` ON `conversations` (`slack_parent_message_id`);--> statement-breakpoint
ALTER TABLE `conversations` DROP COLUMN `slack_parent_message_ts`;