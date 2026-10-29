CREATE TABLE `control_plane_profile_workflows` (
	`profile_version_id` text PRIMARY KEY NOT NULL,
	`definition_id` text NOT NULL,
	`revision` integer NOT NULL,
	`script` text NOT NULL,
	FOREIGN KEY (`profile_version_id`) REFERENCES `control_plane_profile_versions`(`id`) ON UPDATE no action ON DELETE no action
);
