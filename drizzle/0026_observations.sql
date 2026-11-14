CREATE TABLE `observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`at` text NOT NULL,
	`kind` text NOT NULL,
	`actor_handle` text,
	`actor_name` text,
	`text` text DEFAULT '' NOT NULL,
	`url` text,
	`context` text,
	`meta` text DEFAULT '{}' NOT NULL,
	`task_id` integer REFERENCES tasks(id) ON DELETE SET NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `observations_source_external_idx` ON `observations` (`source`,`external_id`);--> statement-breakpoint
CREATE INDEX `observations_open_idx` ON `observations` (`task_id`,`at`);
