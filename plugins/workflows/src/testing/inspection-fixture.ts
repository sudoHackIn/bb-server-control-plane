import register from "./managed-api-fixture.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  getRunRequired,
  startCall,
  ownWorker,
  attachCallThread,
  incrementRepairAttempts,
  settleCall,
  settleRun,
} from "../data.js";
import { createStoredWorkflowTrace } from "../trace-store.js";
export default function setup(bb: BbPluginApi) {
  const base = register(bb);
  const db = bb.storage.database();
  return {
    ...base,
    seedCall(runId: string, threadId: string) {
      db.prepare("UPDATE workflow_runs SET status='running' WHERE id=?").run(
        runId,
      );
      const run = getRunRequired(db, runId);
      const call = startCall(db, {
        runId,
        callIndex: 0,
        cacheKey: `inspection-${runId}`,
        prompt: `input-${runId}`,
        options: {
          selection: null,
          outputSchema: null,
          title: "Inspect worker",
          phase: null,
        },
        selection: {
          providerId: run.originProvider,
          model: run.originModel,
          reasoningLevel: run.originReasoningLevel,
          permissionMode: run.originPermissionMode,
        },
        replay: null,
      });
      ownWorker(
        db,
        threadId,
        runId,
        call.id,
        run.originThreadId,
        run.authorityBindingId,
      );
      attachCallThread(db, call.id, threadId);
      incrementRepairAttempts(db, call.id, "Expected an object");
      const trace = createStoredWorkflowTrace(db, runId);
      const linked = trace.call(0, null);
      linked.admitted(call);
      settleCall(db, {
        id: call.id,
        status: "succeeded",
        result: { visible: true },
        error: null,
      });
      linked.finish("succeeded");
      settleRun(db, {
        id: runId,
        status: "succeeded",
        result: { visible: true },
        error: null,
      });
      trace.finish("succeeded");
      return { callId: call.id, attemptId: trace.id };
    },
    replayReference(callId: string, originalCallId: string) {
      db.prepare(
        "UPDATE workflow_calls SET replayed_from_call_id=? WHERE id=?",
      ).run(originalCallId, callId);
    },
  };
}
