ALTER TABLE conversations ADD `public_id` text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_public_id_unique` ON `conversations` (`public_id`);