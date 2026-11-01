CREATE TABLE `control_plane_agent_invocations` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_kind` text NOT NULL,
	`parent_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`profile_version_id` text NOT NULL,
	`root_id` text NOT NULL,
	`depth` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`input` text NOT NULL,
	`child_key` text NOT NULL,
	`workflow_run_id` text NOT NULL,
	`run_id` text,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `control_plane_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `control_plane_projects`(`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_version_id`) REFERENCES `control_plane_profile_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_plane_agent_invocations_child_key_unique` ON `control_plane_agent_invocations` (`child_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `control_plane_agent_invocations_workflow_run_id_unique` ON `control_plane_agent_invocations` (`workflow_run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `control_plane_agent_invocations_parent_key_idx` ON `control_plane_agent_invocations` (`parent_kind`,`parent_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `control_plane_agent_invocations_root_idx` ON `control_plane_agent_invocations` (`root_id`,`state`);