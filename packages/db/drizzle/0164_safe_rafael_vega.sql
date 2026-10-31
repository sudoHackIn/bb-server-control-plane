CREATE TABLE `control_plane_diagnostic_access` (
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	PRIMARY KEY(`project_id`, `user_id`),
	FOREIGN KEY (`project_id`) REFERENCES `control_plane_projects`(`project_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `control_plane_users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "control_plane_diagnostic_access_revision" CHECK("control_plane_diagnostic_access"."revision" > 0 AND "control_plane_diagnostic_access"."revision" <= 9007199254740991)
);
--> statement-breakpoint
CREATE INDEX `control_plane_diagnostic_access_user_idx` ON `control_plane_diagnostic_access` (`user_id`,`project_id`);