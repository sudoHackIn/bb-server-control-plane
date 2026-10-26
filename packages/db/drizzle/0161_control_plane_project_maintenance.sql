CREATE TABLE `control_plane_project_maintenance` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`project_revision` integer NOT NULL,
	`attempt` integer NOT NULL,
	`phase` text NOT NULL,
	`participants` text NOT NULL,
	`worker_id` text,
	`worker_pid` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `control_plane_projects`(`project_id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "control_plane_project_maintenance_context" CHECK("control_plane_project_maintenance"."phase" = 'complete' OR "control_plane_project_maintenance"."project_id" IS NOT NULL),
	CONSTRAINT "control_plane_project_maintenance_revision" CHECK("control_plane_project_maintenance"."project_revision" >= 1 AND "control_plane_project_maintenance"."project_revision" <= 9007199254740991),
	CONSTRAINT "control_plane_project_maintenance_attempt" CHECK("control_plane_project_maintenance"."attempt" >= 1 AND "control_plane_project_maintenance"."attempt" <= 9007199254740991),
	CONSTRAINT "control_plane_project_maintenance_worker" CHECK(("control_plane_project_maintenance"."worker_id" IS NULL AND "control_plane_project_maintenance"."worker_pid" IS NULL) OR ("control_plane_project_maintenance"."worker_id" IS NOT NULL AND "control_plane_project_maintenance"."worker_pid" IS NOT NULL AND "control_plane_project_maintenance"."worker_pid" > 0))
);
--> statement-breakpoint
CREATE INDEX `control_plane_project_maintenance_pending_idx` ON `control_plane_project_maintenance` (`phase`,`updated_at`);