CREATE TABLE `control_plane_project_policies` (
	`project_id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`applied_revision` integer,
	FOREIGN KEY (`project_id`) REFERENCES `control_plane_projects`(`project_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "control_plane_project_policy_revision" CHECK("control_plane_project_policies"."revision" >= 1 AND "control_plane_project_policies"."revision" <= 9007199254740991),
	CONSTRAINT "control_plane_project_policy_applied" CHECK("control_plane_project_policies"."applied_revision" IS NULL OR ("control_plane_project_policies"."applied_revision" >= 1 AND "control_plane_project_policies"."applied_revision" <= "control_plane_project_policies"."revision"))
);
--> statement-breakpoint
INSERT INTO control_plane_project_policies (project_id) SELECT project_id FROM control_plane_projects;
--> statement-breakpoint
CREATE TRIGGER cp_project_policy_create AFTER INSERT ON control_plane_projects BEGIN INSERT INTO control_plane_project_policies (project_id) VALUES (NEW.project_id); END;
--> statement-breakpoint
CREATE TRIGGER cp_project_policy_binding AFTER UPDATE ON control_plane_projects WHEN OLD.owner_user_id IS NOT NEW.owner_user_id OR OLD.host_id IS NOT NEW.host_id OR OLD.cwd IS NOT NEW.cwd OR OLD.slug IS NOT NEW.slug BEGIN UPDATE control_plane_project_policies SET revision = revision + 1 WHERE project_id IN (OLD.project_id, NEW.project_id); END;
--> statement-breakpoint
CREATE TRIGGER cp_project_policy_grant_insert AFTER INSERT ON control_plane_project_access BEGIN UPDATE control_plane_project_policies SET revision = revision + 1 WHERE project_id = NEW.project_id; END;
--> statement-breakpoint
CREATE TRIGGER cp_project_policy_grant_delete AFTER DELETE ON control_plane_project_access BEGIN UPDATE control_plane_project_policies SET revision = revision + 1 WHERE project_id = OLD.project_id; END;
--> statement-breakpoint
CREATE TRIGGER cp_project_policy_grant_update AFTER UPDATE ON control_plane_project_access WHEN OLD.project_id IS NOT NEW.project_id OR OLD.user_id IS NOT NEW.user_id OR OLD.role IS NOT NEW.role BEGIN UPDATE control_plane_project_policies SET revision = revision + 1 WHERE project_id IN (OLD.project_id, NEW.project_id); END;
--> statement-breakpoint
CREATE TRIGGER cp_project_policy_identity AFTER UPDATE ON control_plane_users WHEN OLD.enabled IS NOT NEW.enabled OR OLD.environment_status IS NOT NEW.environment_status OR OLD.uid IS NOT NEW.uid OR OLD.gid IS NOT NEW.gid OR OLD.home IS NOT NEW.home OR OLD.projects_root IS NOT NEW.projects_root BEGIN UPDATE control_plane_project_policies SET revision = revision + 1 WHERE project_id IN (SELECT project_id FROM control_plane_projects WHERE owner_user_id IN (OLD.id, NEW.id) UNION SELECT project_id FROM control_plane_project_access WHERE user_id IN (OLD.id, NEW.id)); END;
--> statement-breakpoint
CREATE TRIGGER cp_project_policy_project AFTER UPDATE ON projects WHEN OLD.kind IS NOT NEW.kind OR OLD.deleted_at IS NOT NEW.deleted_at BEGIN UPDATE control_plane_project_policies SET revision = revision + 1 WHERE project_id = NEW.id; END;
--> statement-breakpoint
CREATE TRIGGER cp_project_policy_host AFTER UPDATE ON hosts WHEN OLD.destroyed_at IS NOT NEW.destroyed_at BEGIN UPDATE control_plane_project_policies SET revision = revision + 1 WHERE project_id IN (SELECT project_id FROM control_plane_projects WHERE host_id = NEW.id); END;
--> statement-breakpoint
CREATE TRIGGER cp_project_policy_source_insert AFTER INSERT ON project_sources BEGIN UPDATE control_plane_project_policies SET revision = revision + 1 WHERE project_id = NEW.project_id; END;
--> statement-breakpoint
CREATE TRIGGER cp_project_policy_source_delete AFTER DELETE ON project_sources BEGIN UPDATE control_plane_project_policies SET revision = revision + 1 WHERE project_id = OLD.project_id; END;
--> statement-breakpoint
CREATE TRIGGER cp_project_policy_source_update AFTER UPDATE ON project_sources WHEN OLD.project_id IS NOT NEW.project_id OR OLD.type IS NOT NEW.type OR OLD.host_id IS NOT NEW.host_id OR OLD.path IS NOT NEW.path OR OLD.owns_path IS NOT NEW.owns_path BEGIN UPDATE control_plane_project_policies SET revision = revision + 1 WHERE project_id IN (OLD.project_id, NEW.project_id); END;
