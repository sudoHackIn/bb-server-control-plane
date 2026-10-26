import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import Database from "better-sqlite3";

export function createProviderLifecycleFixture({ db, users }) {
  const entries = [];
  let operatorPath;
  const callbacks = async () => {
    try {
      return (await readFile("/srv/bb/provider-callbacks.ndjson", "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  };
  const insert = (writer, table, row) => {
    const columns = Object.keys(row);
    writer
      .prepare(
        `INSERT INTO "${table}" (${columns.map((name) => `"${name}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      )
      .run(...columns.map((name) => row[name]));
  };
  const assertRetained = () => {
    for (const entry of entries) {
      const row = db
        .prepare("SELECT * FROM environments WHERE id=?")
        .get(entry.id);
      assert.equal(row.path, entry.path);
      assert.equal(
        row.environment_provider_id,
        "control-plane-provider-fixture",
      );
      assert.equal(row.resource, entry.resource);
      assert.equal(row.claim_path, entry.claim_path);
      if (entry.status === "creating") {
        assert.equal(row.status, "error");
        assert.match(row.status_message, /Needs operator review/);
      } else {
        assert.equal(row.teardown_status, "failed");
        assert.match(row.teardown_message, /Needs operator review/);
        assert.equal(row.teardown_attempt, 0);
        assert.equal(row.retire_at, null);
      }
    }
  };
  return {
    async verify({ send, token, wait }) {
      const writer = new Database("/srv/bb/bb.db");
      let operator;
      try {
        const base = db
          .prepare(
            "SELECT e.* FROM environments e JOIN control_plane_projects p ON p.project_id=e.project_id WHERE p.owner_user_id=? AND p.slug='app' AND e.path=p.cwd",
          )
          .get(users[0].id);
        const original = db
          .prepare("SELECT * FROM projects WHERE id=?")
          .get(base.project_id);
        operator = {
          ...original,
          id: "prj_provider_" + randomUUID().replaceAll("-", ""),
          name: "Operator provider fixture",
        };
        insert(writer, "projects", operator);
        operatorPath = "/tmp/operator-provider-" + randomUUID();
        const ordinary = {
          ...base,
          id: "env_provider_" + randomUUID(),
          project_id: operator.id,
          path: operatorPath,
          owner_thread_id: null,
          status: "ready",
          provider_owns_path: 0,
          environment_provider_id: "control-plane-provider-fixture",
          environment_provider_plugin_id: "control-plane-tool-fixture",
          environment_provider_instance_key: randomUUID(),
          teardown_status: null,
          teardown_message: null,
          teardown_attempt: 0,
          retire_at: 1,
          claim_path: null,
          resource: null,
        };
        insert(writer, "environments", ordinary);
        for (const user of users) {
          const managed = db
            .prepare(
              "SELECT e.* FROM environments e JOIN control_plane_projects p ON p.project_id=e.project_id WHERE p.owner_user_id=? AND p.slug='app' AND e.path=p.cwd",
            )
            .get(user.id);
          for (const status of ["creating", "ready"]) {
            const path = `${user.projects_root}/provider-${randomUUID()}`;
            const row = {
              ...managed,
              id: "env_provider_" + randomUUID(),
              path,
              status,
              owner_thread_id: null,
              provider_owns_path: 1,
              environment_provider_id: "control-plane-provider-fixture",
              environment_provider_plugin_id: "control-plane-tool-fixture",
              environment_provider_instance_key: randomUUID(),
              claim_path: path,
              resource: JSON.stringify({ retained: user.id }),
              teardown_status: null,
              teardown_message: null,
              teardown_attempt: 0,
              retire_at: status === "ready" ? 1 : null,
            };
            insert(writer, "environments", row);
            entries.push(row);
          }
        }
        const alias = {
          ...ordinary,
          provider_owns_path: 1,
          id: "env_provider_" + randomUUID(),
          path: `${users[0].home}/provider-alias`,
          claim_path: `${users[0].home}/provider-alias`,
          resource: JSON.stringify({ retained: "alias" }),
          retire_at: 1,
        };
        insert(writer, "environments", alias);
        entries.push(alias);
      } finally {
        writer.close();
      }
      await wait(
        async () =>
          (await callbacks()).some(
            (row) => row.operation === "remove" && row.path === operatorPath,
          ),
        "ordinary operator provider callback",
      );
      await wait(
        () =>
          entries.every((entry) => {
            const row = db
              .prepare(
                "SELECT status,teardown_status FROM environments WHERE id=?",
              )
              .get(entry.id);
            return entry.status === "creating"
              ? row.status === "error"
              : row.teardown_status === "failed";
          }),
        "managed provider lifecycle quarantine",
      );
      assertRetained();
      for (const entry of entries.filter((row) => row.status === "ready")) {
        for (const suffix of ["", "?recover=true"]) {
          const refused = await send(
            `/api/v1/environments/${entry.id}/cleanup${suffix}`,
            {},
            token,
          );
          assert.equal(refused.status, 403, JSON.stringify(refused.body));
          assert.equal(
            refused.body.code,
            "managed_environment_provider_denied",
          );
        }
      }
      const observed = await callbacks();
      assert.equal(
        observed.filter((row) => row.operation === "remove").length,
        1,
      );
      assert.equal(
        observed.some((row) =>
          entries.some(
            (entry) =>
              row.path === entry.path || row.projectId === entry.project_id,
          ),
        ),
        false,
      );
      assertRetained();
      return {
        managedLegacyProviderCreationQuarantined: true,
        managedProviderRemovalAndRecoveryDenied: true,
        registeredNamespaceProviderAliasDenied: true,
        ordinaryOperatorProviderCallbackPreserved: true,
      };
    },
    async afterRestart() {
      assertRetained();
      const observed = await callbacks();
      assert.equal(
        observed.filter((row) => row.operation === "remove").length,
        1,
      );
      assert.equal(
        observed.some((row) =>
          entries.some(
            (entry) =>
              row.path === entry.path || row.projectId === entry.project_id,
          ),
        ),
        false,
      );
      return { managedProviderQuarantineAndResourcesSurviveRestart: true };
    },
  };
}
