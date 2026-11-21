CREATE TABLE `conversations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`name` text,
	`kind` text NOT NULL,
	`mine_at` text,
	`theirs_at` text,
	`last_seen_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_source_external_idx` ON `conversations` (`source`,`external_id`);--> statement-breakpoint
ALTER TABLE `observations` ADD `conversation_id` integer REFERENCES conversations(id);--> statement-breakpoint
ALTER TABLE `observations` ADD `person_id` integer REFERENCES people(id);--> statement-breakpoint
CREATE INDEX `observations_conversation_idx` ON `observations` (`conversation_id`,`at`);
