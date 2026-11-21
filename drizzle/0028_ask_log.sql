CREATE TABLE `ask_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`question` text NOT NULL,
	`answer` text DEFAULT '' NOT NULL,
	`unavailable` text,
	`asked_at` text NOT NULL,
	`useful` integer
);
--> statement-breakpoint
CREATE INDEX `ask_log_asked_idx` ON `ask_log` (`asked_at`);--> statement-breakpoint
CREATE TABLE `ask_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ask_id` integer NOT NULL,
	`item_id` integer NOT NULL,
	`chunk_id` integer,
	`cited` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`ask_id`) REFERENCES `ask_log`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ask_sources_item_idx` ON `ask_sources` (`item_id`);--> statement-breakpoint
CREATE INDEX `ask_sources_ask_idx` ON `ask_sources` (`ask_id`);