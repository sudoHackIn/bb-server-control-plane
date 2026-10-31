import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  events,
  prepareCompletedEventOutputData,
  insertPreparedRetainedEventOutput,
} from "@bb/db";
import { withTestHarness } from "../helpers/test-app.js";
import { seedControlPlaneJobSubjects } from "../helpers/control-plane-authority.js";
import { readWorkflowFileArtifacts } from "../../src/control-plane/workflow-file-artifacts.js";

it("reads retained patches and edit-tool artifacts only from owned workers in the requested project", async () => {
  await withTestHarness(async ({ db }) => {
    const { alice, bob } = seedControlPlaneJobSubjects(db);
    function append(
      threadId: string,
      sequence: number,
      item: object,
      itemKind: "fileChange" | "toolCall",
    ) {
      db.insert(events)
        .values({
          id: randomUUID(),
          threadId,
          scopeKind: "turn",
          turnId: "turn",
          sequence,
          type: "item/completed",
          itemKind,
          data: JSON.stringify({ item }),
          createdAt: sequence,
        })
        .run();
    }
    append(
      alice.thread.id,
      1,
      {
        type: "fileChange",
        status: "completed",
        changes: [
          { path: "diagram.puml", kind: "add", diff: "+@startuml\n+@enduml" },
        ],
      },
      "fileChange",
    );
    append(
      alice.thread.id,
      2,
      {
        type: "toolCall",
        tool: "edit",
        status: "failed",
        arguments: { file_path: "draft.txt" },
        result: { error: "Edit failed" },
      },
      "toolCall",
    );
    append(
      alice.thread.id,
      3,
      {
        type: "toolCall",
        tool: "read_file",
        status: "completed",
        arguments: { file_path: "irrelevant.txt" },
        result: "not an edit",
      },
      "toolCall",
    );
    append(
      bob.thread.id,
      1,
      {
        type: "fileChange",
        status: "completed",
        changes: [{ path: "private-bob", kind: "update", diff: "SECRET" }],
      },
      "fileChange",
    );
    const result = readWorkflowFileArtifacts(
      db,
      alice.user.id,
      alice.project.id,
      [
        { threadId: alice.thread.id },
        { threadId: bob.thread.id },
        { threadId: "missing" },
      ],
    );
    expect(result.unavailableWorkers).toBe(2);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toMatchObject({
      path: "diagram.puml",
      kind: "add",
      diff: "+@startuml\n+@enduml",
      diffTruncated: false,
      output: null,
    });
    expect(result.entries[1]).toMatchObject({
      path: "draft.txt",
      kind: "edit",
      status: "failed",
      diff: null,
      output: '{"error":"Edit failed"}',
    });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|private-bob|irrelevant/);
    expect(
      readWorkflowFileArtifacts(db, bob.user.id, alice.project.id, [
        { threadId: alice.thread.id },
      ]).entries,
    ).toEqual([]);
    expect(
      readWorkflowFileArtifacts(db, alice.user.id, bob.project.id, [
        { threadId: alice.thread.id },
      ]).entries,
    ).toEqual([]);
  });
});
it("bounds Unicode patches and marks oversized, malformed and excess artifacts explicitly", async () => {
  await withTestHarness(async ({ db }) => {
    const { alice } = seedControlPlaneJobSubjects(db);
    function insert(sequence: number, data: string) {
      db.insert(events)
        .values({
          id: randomUUID(),
          threadId: alice.thread.id,
          scopeKind: "turn",
          turnId: "turn",
          sequence,
          type: "item/completed",
          itemKind: "fileChange",
          data,
          createdAt: sequence,
        })
        .run();
    }
    insert(
      1,
      JSON.stringify({
        item: {
          type: "fileChange",
          status: "completed",
          changes: [
            { path: "unicode", kind: "update", diff: "Я".repeat(40000) },
          ],
        },
      }),
    );
    insert(2, "invalid");
    insert(3, JSON.stringify({ oversized: "a".repeat(1048577) }));
    insert(
      4,
      JSON.stringify({
        item: {
          type: "fileChange",
          status: "completed",
          changes: Array.from({ length: 120 }, (_, i) => ({
            path: `file-${i}`,
            kind: "add",
          })),
        },
      }),
    );
    const result = readWorkflowFileArtifacts(
      db,
      alice.user.id,
      alice.project.id,
      [{ threadId: alice.thread.id }],
    );
    expect(result.truncated).toBe(true);
    expect(result.entries).toHaveLength(100);
    expect(result.entries[0]?.diffTruncated).toBe(true);
    expect(
      Buffer.byteLength(result.entries[0]?.diff ?? ""),
    ).toBeLessThanOrEqual(65536);
    expect(result.entries[0]?.diff).not.toContain("�");
  });
});

it("hydrates retained edit results within the read budget and marks expired previews as truncated", async () => {
  await withTestHarness(async ({ db }) => {
    const { alice } = seedControlPlaneJobSubjects(db);
    const full = "retained-result-" + "Я".repeat(35000);
    const id = randomUUID();
    const createdAt = Date.now();
    const prepared = prepareCompletedEventOutputData({
      type: "item/completed",
      itemKind: "toolCall",
      createdAt,
      data: JSON.stringify({
        item: {
          type: "toolCall",
          tool: "write_file",
          status: "completed",
          arguments: { file_path: "retained.puml" },
          result: full,
        },
      }),
    });
    expect(prepared.retainedOutput).not.toBeNull();
    db.insert(events)
      .values({
        id,
        threadId: alice.thread.id,
        scopeKind: "turn",
        turnId: "turn",
        sequence: 1,
        type: "item/completed",
        itemKind: "toolCall",
        data: prepared.data,
        createdAt,
      })
      .run();
    if (prepared.retainedOutput)
      insertPreparedRetainedEventOutput(db, {
        eventId: id,
        output: prepared.retainedOutput,
      });
    const worker = [{ threadId: alice.thread.id }];
    const hydrated = readWorkflowFileArtifacts(
      db,
      alice.user.id,
      alice.project.id,
      worker,
    ).entries[0];
    expect(hydrated?.output).toContain("retained-result-");
    expect(hydrated?.output).not.toContain("retention policy");
    expect(hydrated?.outputTruncated).toBe(true);
    db.$client
      .prepare(
        "UPDATE retained_event_outputs SET expires_at=0 WHERE event_id=?",
      )
      .run(id);
    const expired = readWorkflowFileArtifacts(
      db,
      alice.user.id,
      alice.project.id,
      worker,
    ).entries[0];
    expect(expired?.output).toContain("retention policy");
    expect(expired?.outputTruncated).toBe(true);
  });
});
