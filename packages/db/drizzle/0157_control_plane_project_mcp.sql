CREATE TABLE `control_plane_mcp_access` (
	`connector_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`connector_id`, `user_id`),
	FOREIGN KEY (`connector_id`) REFERENCES `control_plane_mcp_connectors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `control_plane_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `control_plane_mcp_access_user_idx` ON `control_plane_mcp_access` (`user_id`,`connector_id`);--> statement-breakpoint
CREATE TABLE `control_plane_mcp_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`connector_revision` integer NOT NULL,
	`revision` integer NOT NULL,
	`enabled` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `control_plane_projects`(`project_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connector_id`) REFERENCES `control_plane_mcp_connectors`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "control_plane_mcp_connections_revisions_positive" CHECK("control_plane_mcp_connections"."revision" > 0 AND "control_plane_mcp_connections"."connector_revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_plane_mcp_connections_project_connector_idx` ON `control_plane_mcp_connections` (`project_id`,`connector_id`);--> statement-breakpoint
CREATE TABLE `control_plane_mcp_connectors` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`endpoint` text NOT NULL,
	`revision` integer NOT NULL,
	`enabled` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "control_plane_mcp_connectors_revision_positive" CHECK("control_plane_mcp_connectors"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_plane_mcp_connectors_slug_unique` ON `control_plane_mcp_connectors` (`slug`);--> statement-breakpoint
CREATE TABLE `control_plane_mcp_credentials` (
	`connector_id` text NOT NULL,
	`user_id` text NOT NULL,
	`connector_revision` integer NOT NULL,
	`revision` integer NOT NULL,
	`ciphertext` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`connector_id`, `user_id`),
	FOREIGN KEY (`connector_id`) REFERENCES `control_plane_mcp_connectors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `control_plane_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "control_plane_mcp_credentials_revisions_positive" CHECK("control_plane_mcp_credentials"."revision" > 0 AND "control_plane_mcp_credentials"."connector_revision" > 0)
);
--> statement-breakpoint
CREATE INDEX `control_plane_mcp_credentials_user_idx` ON `control_plane_mcp_credentials` (`user_id`,`connector_id`);