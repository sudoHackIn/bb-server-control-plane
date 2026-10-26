CREATE TABLE `control_plane_uid_maintenance` (
	`user_id` text PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL,
	`operation_id` text NOT NULL,
	`project_id` text,
	`project_revision` integer NOT NULL,
	`phase` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `control_plane_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `control_plane_projects`(`project_id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "control_plane_uid_maintenance_generation" CHECK("control_plane_uid_maintenance"."generation" >= 1 AND "control_plane_uid_maintenance"."generation" <= 9007199254740991),
	CONSTRAINT "control_plane_uid_maintenance_context" CHECK("control_plane_uid_maintenance"."phase" = 'idle' OR "control_plane_uid_maintenance"."project_id" IS NOT NULL),
	CONSTRAINT "control_plane_uid_maintenance_revision" CHECK("control_plane_uid_maintenance"."project_revision" >= 1 AND "control_plane_uid_maintenance"."project_revision" <= 9007199254740991)
);
--> statement-breakpoint
CREATE INDEX `control_plane_uid_maintenance_operation_idx` ON `control_plane_uid_maintenance` (`operation_id`,`user_id`);