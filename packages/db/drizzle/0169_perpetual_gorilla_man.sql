CREATE TABLE `control_plane_task_source_items` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`input` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`run_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `control_plane_task_sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_plane_task_source_item_identity` ON `control_plane_task_source_items` (`source_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `control_plane_task_source_item_run` ON `control_plane_task_source_items` (`run_id`);--> statement-breakpoint
CREATE INDEX `control_plane_task_source_item_pending` ON `control_plane_task_source_items` (`source_id`,`state`,`id`);--> statement-breakpoint
CREATE TABLE `control_plane_task_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`profile_version_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`interval_seconds` integer NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`checkpoint` text,
	`next_poll_at` integer NOT NULL,
	`last_poll_at` integer,
	`failures` integer DEFAULT 0 NOT NULL,
	`error` text,
	`reader_job_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `control_plane_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_version_id`) REFERENCES `control_plane_profile_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `control_plane_task_sources_owner_project` ON `control_plane_task_sources` (`owner_user_id`,`project_id`,`id`);--> statement-breakpoint
CREATE INDEX `control_plane_task_sources_due` ON `control_plane_task_sources` (`enabled`,`next_poll_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `control_plane_task_sources_project_kind` ON `control_plane_task_sources` (`project_id`,`kind`);