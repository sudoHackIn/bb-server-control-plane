CREATE TABLE `control_plane_webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`delivery_key` text NOT NULL,
	`payload_hash` text NOT NULL,
	`state` text NOT NULL,
	`run_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`webhook_id`) REFERENCES `control_plane_webhooks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_plane_webhook_deliveries_key_idx` ON `control_plane_webhook_deliveries` (`webhook_id`,`delivery_key`);--> statement-breakpoint
CREATE INDEX `control_plane_webhook_deliveries_run_idx` ON `control_plane_webhook_deliveries` (`run_id`);--> statement-breakpoint
CREATE INDEX `control_plane_webhook_deliveries_page_idx` ON `control_plane_webhook_deliveries` (`webhook_id`,`id`);--> statement-breakpoint
CREATE TABLE `control_plane_webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`profile_version_id` text NOT NULL,
	`name` text NOT NULL,
	`input_field` text NOT NULL,
	`secret_hash` text NOT NULL,
	`enabled` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `control_plane_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `control_plane_projects`(`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_version_id`) REFERENCES `control_plane_profile_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `control_plane_webhooks_owner_idx` ON `control_plane_webhooks` (`owner_user_id`,`project_id`,`id`);