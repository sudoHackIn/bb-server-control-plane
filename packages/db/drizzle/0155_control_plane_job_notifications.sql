CREATE TABLE `control_plane_job_notifications` (
	`binding_id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`accepted_at` integer NOT NULL,
	FOREIGN KEY (`binding_id`) REFERENCES `control_plane_job_bindings`(`id`) ON UPDATE no action ON DELETE no action
);
