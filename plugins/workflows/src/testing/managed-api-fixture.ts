import { z } from "zod";
import { registerWorkflowDefinitionApi } from "../definition-api.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createWorkflowService } from "../service.js";
import { migrations, settleRun } from "../data.js";
import { registerManagedWorkflowApi } from "../managed-api.js";

export default function register(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  const service = createWorkflowService(bb, db);
  registerManagedWorkflowApi(bb, service);
  registerWorkflowDefinitionApi(bb, db, service);
  return {
    definitionCount() {
      return z
        .number()
        .parse(
          db.prepare("SELECT count(*) FROM workflow_definitions").pluck().get(),
        );
    },
    failDefinitionWrites(enabled: boolean) {
      db.exec("DROP TRIGGER IF EXISTS reject_definition_write");
      if (enabled)
        db.exec(
          "CREATE TEMP TRIGGER reject_definition_write BEFORE INSERT ON workflow_definition_versions BEGIN SELECT RAISE(ABORT,'Definition write rejected'); END;",
        );
    },
    settle(id: string) {
      settleRun(db, {
        id,
        status: "succeeded",
        result: { value: 42 },
        error: null,
      });
    },
  };
}
