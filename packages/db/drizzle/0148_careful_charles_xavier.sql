CREATE TABLE `control_plane_project_access` (
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`project_id`, `user_id`),
	FOREIGN KEY (`project_id`) REFERENCES `control_plane_projects`(`project_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `control_plane_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `control_plane_project_access_user_idx` ON `control_plane_project_access` (`user_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `control_plane_projects` (
	`project_id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`slug` text NOT NULL,
	`host_id` text NOT NULL,
	`cwd` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `control_plane_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_plane_projects_owner_slug_idx` ON `control_plane_projects` (`owner_user_id`,`slug`);