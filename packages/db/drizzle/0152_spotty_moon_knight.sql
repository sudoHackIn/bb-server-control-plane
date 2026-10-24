CREATE TABLE `control_plane_job_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`object_id` text NOT NULL,
	`revision` integer NOT NULL,
	`owner_user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`profile_version_id` text NOT NULL,
	`origin_thread_id` text,
	`source_binding_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `control_plane_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `control_plane_projects`(`project_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_version_id`) REFERENCES `control_plane_profile_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_binding_id`) REFERENCES `control_plane_job_bindings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_plane_job_bindings_object_idx` ON `control_plane_job_bindings` (`kind`,`object_id`,`revision`);--> statement-breakpoint
CREATE INDEX `control_plane_job_bindings_owner_idx` ON `control_plane_job_bindings` (`owner_user_id`,`id`);--> statement-breakpoint
CREATE INDEX `control_plane_job_bindings_source_idx` ON `control_plane_job_bindings` (`source_binding_id`);