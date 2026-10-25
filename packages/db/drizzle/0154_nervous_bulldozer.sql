ALTER TABLE `control_plane_threads` ADD `job_binding_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `control_plane_threads_job_idx` ON `control_plane_threads` (`job_binding_id`);