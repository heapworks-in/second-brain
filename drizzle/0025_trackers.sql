CREATE TABLE `trackers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`container_id` integer,
	`source_name` text DEFAULT '' NOT NULL,
	`sheet_name` text DEFAULT '' NOT NULL,
	`headers` text DEFAULT '[]' NOT NULL,
	`mapping` text DEFAULT '{}' NOT NULL,
	`status_map` text DEFAULT '{}' NOT NULL,
	`imported_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`container_id`) REFERENCES `containers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trackers_slug_unique` ON `trackers` (`slug`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `owner_person_id` integer REFERENCES people(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `tracker_id` integer REFERENCES trackers(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `theme` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `parent_label` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `status_label` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `sheet_extra` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `sheet_row` integer;--> statement-breakpoint
CREATE INDEX `tasks_tracker_row_idx` ON `tasks` (`tracker_id`,`sheet_row`);