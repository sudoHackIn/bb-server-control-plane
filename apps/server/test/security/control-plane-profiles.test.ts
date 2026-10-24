import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { z } from "zod";
import type { ControlPlaneProfileDefinition } from "@bb/domain";
import { ControlPlaneRegistry, controlPlaneUserSessions } from "@bb/db";
import { createControlPlaneClient } from "@bb/sdk/node";
import { createApp } from "../../src/server.js";
import {
  createControlPlaneAccess,
  withControlPlaneUser,
} from "../../src/control-plane/access.js";
import { createControlPlaneUserAccess } from "../../src/control-plane/user-access.js";
import { hashAdminPassword } from "../../src/control-plane/credentials.js";
import { withTestHarness } from "../helpers/test-app.js";

it("serves the administrative and personal SDK catalogs with real authorization, immutable versions and revocation", async () => {
  await withTestHarness(async (harness) => {
    const registry = new ControlPlaneRegistry(harness.db, {
      usersRoot: "/srv/users",
      firstUid: 200000,
      lastUid: 299999,
    });
    const alice = registry.reserve("alice", 1),
      bob = registry.reserve("bob", 1);
    const origin = "https://bb.example";
    harness.config.appUrl = origin;
    const server = createApp(harness.deps, {
      controlPlane: createControlPlaneAccess(
        {
          version: 1,
          publicOrigin: origin,
          admin: {
            login: "admin",
            passwordHash: await hashAdminPassword("test-only-profile-password"),
          },
        },
        Date.now,
        createControlPlaneUserAccess(registry, origin),
      ),
    });
    const send = (
      method: string,
      path: string,
      token: string | null,
      body?: object,
    ) =>
      server.app.request(path, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    const login = await send("POST", "/control-plane/login", null, {
      login: "admin",
      password: "test-only-profile-password",
    });
    const adminToken = z
      .object({ token: z.string() })
      .parse(await login.json()).token;
    const client = (token: string) =>
      createControlPlaneClient({
        origin,
        token: () => token,
        fetch: async (input, init) =>
          server.app.fetch(new Request(input, init)),
      });
    const admin = client(adminToken).admin.profiles;
    const tokens = [alice, bob].map((user) => {
      const token = `agt_${randomBytes(32).toString("base64url")}`;
      harness.db
        .insert(controlPlaneUserSessions)
        .values({
          userId: user.id,
          digest: createHash("sha256").update(token).digest("hex"),
          expiresAt: Date.now() + 60000,
        })
        .run();
      return token;
    });
    const aliceToken = tokens[0],
      bobToken = tokens[1];
    if (!aliceToken || !bobToken) throw new Error("Missing fixture credential");
    const aliceApi = client(aliceToken),
      bobApi = client(bobToken);
    const definition: ControlPlaneProfileDefinition = {
      prompt: "Review safely",
      providerId: "qwen-server",
      model: "qwen-approved",
      reasoningLevel: "none",
      permissionMode: "full",
      tools: ["read_file"],
      mcpServers: [],
    };
    const base = "/control-plane/admin/profiles";
    try {
      expect((await send("GET", base, null)).status).toBe(401);
      expect(
        (
          await send("POST", base, aliceToken, {
            slug: "escape",
            name: "Escape",
            definition,
          })
        ).status,
      ).toBe(401);
      const created = await admin.create({
        slug: "review",
        name: "Review",
        definition,
      });
      const id = created.profile.id;
      const privateFetch = server.sdkFetch;
      if (!privateFetch) throw new Error("Missing private SDK transport");
      await expect(
        withControlPlaneUser(alice.id, () =>
          privateFetch(new URL(base, origin)),
        ),
      ).rejects.toThrow("Internal SDK must use the BB API");
      expect(created.version.version).toBe(1);
      expect((await aliceApi.profiles.list()).profiles).toEqual([]);
      await expect(bobApi.profiles.get(id)).rejects.toThrow("404");
      await admin.setAccess(id, alice.id, true);
      expect((await admin.access(id)).users.map((user) => user.userId)).toEqual(
        [alice.id],
      );
      expect((await aliceApi.profiles.list()).profiles[0]?.id).toBe(id);
      const revised = await admin.publish(id, {
        ...definition,
        model: "qwen-revised",
        tools: [],
      });
      expect(revised.version.version).toBe(2);
      expect((await aliceApi.profiles.get(id)).version.id).toBe(
        revised.version.id,
      );
      expect(
        (await aliceApi.profiles.get(id, { versionId: created.version.id }))
          .version.definition,
      ).toEqual(definition);
      const history = await aliceApi.profiles.versions(id, { limit: 1 });
      expect(history.nextCursor).toBe(2);
      expect(
        (
          await aliceApi.profiles.versions(id, {
            cursor: history.nextCursor ?? undefined,
          })
        ).versions[0]?.version,
      ).toBe(1);
      await expect(bobApi.profiles.versions(id)).rejects.toThrow("404");
      await expect(
        aliceApi.admin.profiles.setAccess(id, bob.id, true),
      ).rejects.toThrow("401");
      for (const body of [
        { slug: "ignored", name: "Ignored", definition, ownerUserId: alice.id },
        {
          slug: "ignored",
          name: "Ignored",
          definition: { ...definition, env: { API_KEY: "not-accepted" } },
        },
        {
          slug: "ignored",
          name: "Ignored",
          definition: { ...definition, tools: ["read_file", "read_file"] },
        },
      ])
        expect((await send("POST", base, adminToken, body)).status).toBe(400);
      expect(
        (
          await send("POST", base, adminToken, {
            slug: "review",
            name: "Conflict",
            definition,
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await send("POST", `${base}/${randomUUID()}/versions`, adminToken, {
            definition,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await send(
            "PUT",
            `${base}/${id}/versions/${randomUUID()}/enabled`,
            adminToken,
            { enabled: false },
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await send(
            "GET",
            "/control-plane/user/profiles?ownerUserId=" + bob.id,
            aliceToken,
          )
        ).status,
      ).toBe(400);
      await admin.setEnabled(id, false, { versionId: revised.version.id });
      await expect(
        aliceApi.profiles.get(id, { versionId: revised.version.id }),
      ).rejects.toThrow("404");
      expect((await aliceApi.profiles.get(id)).version.version).toBe(1);
      expect((await admin.versions(id)).versions).toHaveLength(2);
      await admin.setEnabled(id, false, { versionId: created.version.id });
      expect((await aliceApi.profiles.list()).profiles).toEqual([]);
      await expect(
        aliceApi.profiles.get(id, { versionId: created.version.id }),
      ).rejects.toThrow("404");
      await admin.setEnabled(id, true, { versionId: created.version.id });
      await admin.setEnabled(id, false);
      await expect(aliceApi.profiles.get(id)).rejects.toThrow("404");
      expect((await admin.list()).profiles[0]?.enabled).toBe(false);
      await admin.setEnabled(id, true);
      await admin.setAccess(id, alice.id, false);
      expect((await aliceApi.profiles.list()).profiles).toEqual([]);
      await expect(
        aliceApi.profiles.get(id, { versionId: created.version.id }),
      ).rejects.toThrow("404");
      expect((await bobApi.profiles.list()).profiles).toEqual([]);
    } finally {
      await server.pluginService.stop();
      await server.closeWebSockets();
    }
  });
});
