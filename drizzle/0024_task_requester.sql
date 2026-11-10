-- Who asked, and when. `on delete set null` is written by hand because drizzle-kit leaves the
-- action off an added column, and foreign keys are enforced (`foreign_keys = ON`): without it,
-- deleting a person whose name is on an open task fails the delete instead of forgetting them.
ALTER TABLE `tasks` ADD `requester_person_id` integer REFERENCES people(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `asked_on` text;
