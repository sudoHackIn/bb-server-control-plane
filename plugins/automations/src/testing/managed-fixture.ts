import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createAutomationService } from "../service.js";
import { automationRpcContract, createRpcHandlers } from "../rpc.js";
import { migrations, createAutomation } from "../data.js";

export default function fixture(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  const configuration = {
    bb,
    db,
    pluginDataDir: "/unused/managed",
    serverUrl: "http://unused",
  };
  let service = createAutomationService(configuration);
  bb.rpc.register(automationRpcContract, createRpcHandlers(service));
  return {
    scriptAttempt(runId: string) {
      return db
        .prepare(
          "SELECT job_id AS jobId,cleanup_error AS cleanupError,result_json AS resultJson FROM automation_script_attempts WHERE run_id=?",
        )
        .get(runId);
    },
    cancelRequested(runId: string) {
      return (
        db
          .prepare(
            "SELECT 1 FROM automation_run_authorities WHERE run_id=? AND cancel_requested_at IS NOT NULL",
          )
          .get(runId) !== undefined
      );
    },
    restart() {
      service = createAutomationService(configuration);
    },
    tick: (startup = false) =>
      service.managedTick?.(startup, new AbortController().signal),
    fault(enabled: boolean) {
      if (enabled)
        db.exec(
          "CREATE TEMP TRIGGER reject_automation_version BEFORE INSERT ON automation_versions BEGIN SELECT RAISE(ABORT,'version write rejected'); END;",
        );
      else db.exec("DROP TRIGGER reject_automation_version;");
    },
    versions(id: string) {
      return db
        .prepare(
          "SELECT revision,execution_json FROM automation_versions WHERE automation_id=? ORDER BY revision",
        )
        .all(id);
    },
    due(id: string) {
      db.prepare("UPDATE automations SET next_run_at=? WHERE id=?").run(
        Date.now() - 1,
        id,
      );
    },
    legacy(projectId: string) {
      return createAutomation(db, {
        projectId,
        name: "Unassigned legacy",
        enabled: true,
        trigger: { triggerType: "once", runAt: Date.now() - 1 },
        runMode: "script",
        execution: {
          mode: "script",
          script: "touch /tmp/not-authorized",
          workingDirectory: { type: "project" },
          timeoutMs: 1000,
        },
        origin: "human",
        createdByThreadId: null,
        nextRunAt: Date.now() - 1,
      }).id;
    },
  };
}
