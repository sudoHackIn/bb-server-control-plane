CREATE TABLE `control_plane_auth_flows` (
	`id` text PRIMARY KEY NOT NULL,
	`client_name` text NOT NULL,
	`challenge` text NOT NULL,
	`status` text NOT NULL,
	`approval_login` text,
	`csrf_hash` text,
	`user_id` text,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `control_plane_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `control_plane_counters` (
	`name` text PRIMARY KEY NOT NULL,
	`next_value` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `control_plane_user_sessions` (
	`digest` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `control_plane_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `control_plane_users` (
	`id` text PRIMARY KEY NOT NULL,
	`login` text NOT NULL,
	`uid` integer NOT NULL,
	`gid` integer NOT NULL,
	`home` text NOT NULL,
	`projects_root` text NOT NULL,
	`enabled` integer NOT NULL,
	`environment_status` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_plane_users_login_unique` ON `control_plane_users` (`login`);--> statement-breakpoint
CREATE UNIQUE INDEX `control_plane_users_uid_unique` ON `control_plane_users` (`uid`);--> statement-breakpoint
CREATE UNIQUE INDEX `control_plane_users_home_unique` ON `control_plane_users` (`home`);--> statement-breakpoint
CREATE UNIQUE INDEX `control_plane_users_projects_root_unique` ON `control_plane_users` (`projects_root`);