CREATE TABLE `control_plane_test_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`source_run_id` text NOT NULL,
	`source_project_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`target_json` text NOT NULL,
	`input_json` text NOT NULL,
	`source_hash` text NOT NULL,
	`tested_source_hash` text NOT NULL,
	`profile_json` text NOT NULL,
	`script` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `control_plane_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `control_plane_projects`(`project_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_plane_test_runs_run_id_unique` ON `control_plane_test_runs` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `control_plane_test_runs_request_idx` ON `control_plane_test_runs` (`requested_by`,`idempotency_key`);