CREATE TABLE `proposals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`source_ref` text NOT NULL,
	`title` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`rank` real DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`snoozed_until` text,
	`created_at` text NOT NULL,
	`decided_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proposals_kind_ref_idx` ON `proposals` (`kind`,`source_ref`);--> statement-breakpoint
CREATE INDEX `proposals_state_rank_idx` ON `proposals` (`state`,`rank`);--> statement-breakpoint
CREATE INDEX `proposals_kind_decided_idx` ON `proposals` (`kind`,`decided_at`);--> statement-breakpoint
ALTER TABLE `meeting_series_decisions` ADD `last_verified` text;--> statement-breakpoint
ALTER TABLE `meeting_series_decisions` ADD `confidence` real;