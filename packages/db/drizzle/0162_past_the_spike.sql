PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_control_plane_threads` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`qwen_session_id` text,
	`job_binding_id` text,
	`profile_version_id` text,
	`run_source` text,
	`run_idempotency_key` text,
	`run_input_digest` text,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `control_plane_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_version_id`) REFERENCES `control_plane_profile_versions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "control_plane_threads_run_fields" CHECK(("__new_control_plane_threads"."run_source" IS NULL AND "__new_control_plane_threads"."run_idempotency_key" IS NULL AND "__new_control_plane_threads"."run_input_digest" IS NULL) OR ("__new_control_plane_threads"."run_source" = 'manual' AND "__new_control_plane_threads"."run_idempotency_key" IS NOT NULL AND "__new_control_plane_threads"."run_input_digest" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_control_plane_threads`("thread_id", "owner_user_id", "qwen_session_id", "job_binding_id", "profile_version_id", "run_source", "run_idempotency_key", "run_input_digest") SELECT "thread_id", "owner_user_id", "qwen_session_id", "job_binding_id", "profile_version_id", NULL, NULL, NULL FROM `control_plane_threads`;--> statement-breakpoint
DROP TABLE `control_plane_threads`;--> statement-breakpoint
ALTER TABLE `__new_control_plane_threads` RENAME TO `control_plane_threads`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `control_plane_threads_owner_idx` ON `control_plane_threads` (`owner_user_id`,`thread_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `control_plane_threads_session_idx` ON `control_plane_threads` (`qwen_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `control_plane_threads_job_idx` ON `control_plane_threads` (`job_binding_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `control_plane_threads_run_key_idx` ON `control_plane_threads` (`owner_user_id`,`run_idempotency_key`) WHERE "control_plane_threads"."run_source" = 'manual';
