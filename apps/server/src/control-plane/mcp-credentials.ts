import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import {
  ControlPlaneMcpError,
  controlPlaneMcpCredentials as credentials,
  controlPlaneMcpCredentialMetadata,
  requireControlPlaneMcpConnector,
  type DbConnection,
} from "@bb/db";
import { controlPlaneMcpCredentialInputSchema } from "@bb/domain";
import { readPrivateEncryptionKey } from "@bb/secret-storage";

async function key(db: DbConnection, dataDir: string) {
  try {
    return await readPrivateEncryptionKey({
      dataDir,
      fileName: "control-plane-mcp-key",
      createIfMissing: () =>
        !db
          .select({ userId: credentials.userId })
          .from(credentials)
          .where(isNotNull(credentials.ciphertext))
          .limit(1)
          .get(),
    });
  } catch {
    throw new ControlPlaneMcpError("credential_unavailable");
  }
}
function aad(
  userId: string,
  connectorId: string,
  connectorRevision: number,
  revision: number,
) {
  return Buffer.from(
    JSON.stringify([1, userId, connectorId, connectorRevision, revision]),
  );
}
export function createControlPlaneMcpCredentials(
  db: DbConnection,
  dataDir: string,
) {
  return {
    metadata: (userId: string, connectorId: string) =>
      controlPlaneMcpCredentialMetadata(db, userId, connectorId),
    async set(
      userId: string,
      connectorId: string,
      input: import("zod").z.infer<typeof controlPlaneMcpCredentialInputSchema>,
    ) {
      const parsed = controlPlaneMcpCredentialInputSchema.parse(input);
      requireControlPlaneMcpConnector(
        db,
        userId,
        connectorId,
        parsed.connectorRevision,
      );
      const encryptionKey = await key(db, dataDir);
      const revision = parsed.expectedRevision + 1;
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
      cipher.setAAD(
        aad(userId, connectorId, parsed.connectorRevision, revision),
      );
      const bytes = Buffer.concat([
        cipher.update(parsed.token, "utf8"),
        cipher.final(),
      ]);
      const value = Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString(
        "base64",
      );
      return db.transaction(
        (tx) => {
          requireControlPlaneMcpConnector(
            tx,
            userId,
            connectorId,
            parsed.connectorRevision,
          );
          const previous = controlPlaneMcpCredentialMetadata(
            tx,
            userId,
            connectorId,
          );
          if (previous.revision !== parsed.expectedRevision)
            throw new ControlPlaneMcpError("conflict");
          tx.insert(credentials)
            .values({
              userId,
              connectorId,
              connectorRevision: parsed.connectorRevision,
              revision,
              ciphertext: value,
              updatedAt: Date.now(),
            })
            .onConflictDoUpdate({
              target: [credentials.connectorId, credentials.userId],
              set: {
                connectorRevision: parsed.connectorRevision,
                revision,
                ciphertext: value,
                updatedAt: Date.now(),
              },
            })
            .run();
          return controlPlaneMcpCredentialMetadata(tx, userId, connectorId);
        },
        { behavior: "immediate" },
      );
    },
    revoke(userId: string, connectorId: string, expectedRevision: number) {
      const row = db
        .update(credentials)
        .set({
          ciphertext: null,
          revision: expectedRevision + 1,
          updatedAt: Date.now(),
        })
        .where(
          and(
            eq(credentials.userId, userId),
            eq(credentials.connectorId, connectorId),
            eq(credentials.revision, expectedRevision),
          ),
        )
        .returning({ revision: credentials.revision })
        .get();
      if (!row) throw new ControlPlaneMcpError("conflict");
      return controlPlaneMcpCredentialMetadata(db, userId, connectorId);
    },
    async resolve(
      userId: string,
      connectorId: string,
      connectorRevision: number,
    ) {
      requireControlPlaneMcpConnector(
        db,
        userId,
        connectorId,
        connectorRevision,
      );
      const row = db
        .select()
        .from(credentials)
        .where(
          and(
            eq(credentials.userId, userId),
            eq(credentials.connectorId, connectorId),
          ),
        )
        .get();
      if (!row?.ciphertext || row.connectorRevision !== connectorRevision)
        throw new ControlPlaneMcpError("credential_unavailable");
      const encryptionKey = await key(db, dataDir);
      try {
        const bytes = Buffer.from(row.ciphertext, "base64");
        const decipher = createDecipheriv(
          "aes-256-gcm",
          encryptionKey,
          bytes.subarray(0, 12),
        );
        decipher.setAAD(
          aad(userId, connectorId, connectorRevision, row.revision),
        );
        decipher.setAuthTag(bytes.subarray(12, 28));
        const value = Buffer.concat([
          decipher.update(bytes.subarray(28)),
          decipher.final(),
        ]).toString("utf8");
        requireControlPlaneMcpConnector(
          db,
          userId,
          connectorId,
          connectorRevision,
        );
        const current = db
          .select({
            ciphertext: credentials.ciphertext,
            revision: credentials.revision,
          })
          .from(credentials)
          .where(
            and(
              eq(credentials.userId, userId),
              eq(credentials.connectorId, connectorId),
            ),
          )
          .get();
        if (
          current?.revision !== row.revision ||
          current.ciphertext !== row.ciphertext
        )
          throw new Error("Credential changed");
        return value;
      } catch {
        throw new ControlPlaneMcpError("credential_unavailable");
      }
    },
  };
}
export type ControlPlaneMcpCredentials = ReturnType<
  typeof createControlPlaneMcpCredentials
>;
