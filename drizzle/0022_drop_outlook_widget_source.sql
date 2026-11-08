-- The Outlook Calendar widget reader is gone. It read an undocumented cache that Outlook only
-- wrote while its Notification Center widget was added, and it produced a second row for every
-- meeting of anyone whose work account was already in macOS Internet Accounts. The published-ICS
-- feed is the supported way to get an Outlook calendar in, and is untouched.
--
-- Rows it synced are deleted rather than left behind: nothing refreshes or purges them any more,
-- so they would sit permanently stale, duplicating whatever EventKit reports for the same
-- meetings -- which the removed module's own comment called worse than useless.
--
-- No DDL: `source` is a drizzle TS union with no SQL check constraint behind it, so dropping
-- "outlook" from it needs no column change and leaves the 0021 snapshot accurate.
DELETE FROM calendar_events WHERE source = 'outlook';
--> statement-breakpoint
DELETE FROM settings WHERE key IN ('calendar.outlookEnabled', 'calendar.outlookSyncedAt', 'calendar.outlookError', 'calendar.outlookCount');
