CREATE TABLE `control_plane_profile_access` (
	`profile_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`profile_id`, `user_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `control_plane_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `control_plane_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `control_plane_profile_access_user_idx` ON `control_plane_profile_access` (`user_id`,`profile_id`);--> statement-breakpoint
CREATE TABLE `control_plane_profile_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`version` integer NOT NULL,
	`enabled` integer NOT NULL,
	`definition` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `control_plane_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "control_plane_profile_versions_positive" CHECK("control_plane_profile_versions"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_plane_profile_versions_revision_idx` ON `control_plane_profile_versions` (`profile_id`,`version`);--> statement-breakpoint
CREATE TABLE `control_plane_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_plane_profiles_slug_unique` ON `control_plane_profiles` (`slug`);