import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createWorkflowService } from "../service.js";
import { migrations, settleRun } from "../data.js";
import { registerManagedWorkflowApi } from "../managed-api.js";

export default function register(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  registerManagedWorkflowApi(bb, createWorkflowService(bb, db));
  return {
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
