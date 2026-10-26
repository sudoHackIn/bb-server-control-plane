import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { z } from "zod";
import { createConnection } from "@bb/db";
import { createControlPlaneMcpCredentials } from "../../src/control-plane/mcp-credentials.js";

const input = z
  .object({
    userId: z.string().uuid(),
    connectorId: z.string().uuid(),
    connectorRevision: z.number().int().positive(),
    digest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
  .parse(JSON.parse(process.argv[2] ?? "null"));
const db = createConnection("/srv/bb/bb.db");
try {
  const value = await createControlPlaneMcpCredentials(db, "/srv/bb").resolve(
    input.userId,
    input.connectorId,
    input.connectorRevision,
  );
  assert.equal(createHash("sha256").update(value).digest("hex"), input.digest);
  process.stdout.write(JSON.stringify({ verified: true }));
} finally {
  db.$client.close();
}
