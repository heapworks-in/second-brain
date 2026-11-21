CREATE TABLE `proposal_briefs` (
	`proposal_id` integer PRIMARY KEY NOT NULL,
	`item_id` integer,
	`title` text,
	`excerpt` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`proposal_id`) REFERENCES `proposals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `proposal_briefs_item_idx` ON `proposal_briefs` (`item_id`);--> statement-breakpoint
ALTER TABLE `ask_log` ADD `source` text DEFAULT 'ask' NOT NULL;