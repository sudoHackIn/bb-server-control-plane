CREATE TABLE `control_plane_mcp_tool_bindings` (
	`thread_id` text NOT NULL,
	`name` text NOT NULL,
	`connection_id` text NOT NULL,
	`connection_revision` integer NOT NULL,
	`connector_revision` integer NOT NULL,
	`credential_revision` integer NOT NULL,
	`profile_version_id` text NOT NULL,
	`definition` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`thread_id`, `name`),
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `control_plane_mcp_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_version_id`) REFERENCES `control_plane_profile_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `control_plane_mcp_tool_bindings_connection_idx` ON `control_plane_mcp_tool_bindings` (`connection_id`);