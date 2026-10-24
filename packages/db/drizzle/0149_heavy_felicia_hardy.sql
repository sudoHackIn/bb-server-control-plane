CREATE TABLE `control_plane_threads` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`qwen_session_id` text,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `control_plane_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `control_plane_threads_owner_idx` ON `control_plane_threads` (`owner_user_id`,`thread_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `control_plane_threads_session_idx` ON `control_plane_threads` (`qwen_session_id`);