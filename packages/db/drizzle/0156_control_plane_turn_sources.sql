CREATE TABLE `control_plane_turn_sources` (
	`thread_id` text NOT NULL,
	`request_id` text NOT NULL,
	`source_request_id` text,
	PRIMARY KEY(`thread_id`, `request_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `control_plane_job_notifications` ADD `request_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `control_plane_job_notifications_request_idx` ON `control_plane_job_notifications` (`thread_id`,`request_id`);