import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import {
  controlPlaneAuthFlows,
  controlPlaneCounters,
  controlPlaneUsers,
  controlPlaneUserSessions,
} from "../schema.js";

export type ControlPlaneUser = typeof controlPlaneUsers.$inferSelect;
export type ControlPlaneAuthFlow = typeof controlPlaneAuthFlows.$inferSelect;
export interface ControlPlaneAllocation {
  usersRoot: string;
  firstUid: number;
  lastUid: number;
}

export class ControlPlaneRegistry {
  constructor(
    readonly db: DbConnection,
    readonly allocation: ControlPlaneAllocation,
  ) {}

  user(login: string) {
    return this.db
      .select()
      .from(controlPlaneUsers)
      .where(eq(controlPlaneUsers.login, login))
      .get();
  }

  reserve(login: string, now: number): ControlPlaneUser {
    return this.db.transaction(
      (tx) => {
        const old = tx
          .select()
          .from(controlPlaneUsers)
          .where(eq(controlPlaneUsers.login, login))
          .get();
        if (old) return old;
        tx.insert(controlPlaneCounters)
          .values({ name: "uid", nextValue: this.allocation.firstUid })
          .onConflictDoNothing()
          .run();
        const counter = tx
          .select()
          .from(controlPlaneCounters)
          .where(eq(controlPlaneCounters.name, "uid"))
          .get();
        if (
          !counter ||
          counter.nextValue < this.allocation.firstUid ||
          counter.nextValue > this.allocation.lastUid
        )
          throw new Error(
            "User UID allocation exhausted or configuration changed",
          );
        tx.update(controlPlaneCounters)
          .set({ nextValue: counter.nextValue + 1 })
          .where(eq(controlPlaneCounters.name, "uid"))
          .run();
        const id = randomUUID();
        return tx
          .insert(controlPlaneUsers)
          .values({
            id,
            login,
            uid: counter.nextValue,
            gid: counter.nextValue,
            home: join(this.allocation.usersRoot, id, "home"),
            projectsRoot: join(this.allocation.usersRoot, id, "projects"),
            enabled: true,
            environmentStatus: "allocated",
            createdAt: now,
          })
          .returning()
          .get();
      },
      { behavior: "immediate" },
    );
  }

  createFlow(flow: typeof controlPlaneAuthFlows.$inferInsert, now: number) {
    return this.db.transaction(
      (tx) => {
        tx.delete(controlPlaneAuthFlows)
          .where(lte(controlPlaneAuthFlows.expiresAt, now))
          .run();
        tx.delete(controlPlaneUserSessions)
          .where(lte(controlPlaneUserSessions.expiresAt, now))
          .run();
        const count = tx
          .select({ value: sql<number>`count(*)` })
          .from(controlPlaneAuthFlows)
          .get();
        if ((count?.value ?? 0) >= 1024) return false;
        tx.insert(controlPlaneAuthFlows).values(flow).run();
        return true;
      },
      { behavior: "immediate" },
    );
  }

  flow(id: string) {
    return this.db
      .select()
      .from(controlPlaneAuthFlows)
      .where(eq(controlPlaneAuthFlows.id, id))
      .get();
  }

  approval(id: string, login: string, csrfHash: string, now: number) {
    return (
      this.db
        .update(controlPlaneAuthFlows)
        .set({ approvalLogin: login, csrfHash })
        .where(
          and(
            eq(controlPlaneAuthFlows.id, id),
            eq(controlPlaneAuthFlows.status, "pending"),
            gt(controlPlaneAuthFlows.expiresAt, now),
          ),
        )
        .run().changes === 1
    );
  }

  decide(
    id: string,
    login: string,
    csrfHash: string,
    userId: string | null,
    now: number,
  ) {
    return (
      this.db
        .update(controlPlaneAuthFlows)
        .set({ status: userId ? "approved" : "denied", userId })
        .where(
          and(
            eq(controlPlaneAuthFlows.id, id),
            eq(controlPlaneAuthFlows.status, "pending"),
            eq(controlPlaneAuthFlows.approvalLogin, login),
            eq(controlPlaneAuthFlows.csrfHash, csrfHash),
            gt(controlPlaneAuthFlows.expiresAt, now),
          ),
        )
        .run().changes === 1
    );
  }

  consume(
    id: string,
    userId: string,
    digest: string,
    expiresAt: number,
    now: number,
  ) {
    return this.db.transaction(
      (tx) => {
        const user = tx
          .select()
          .from(controlPlaneUsers)
          .where(
            and(
              eq(controlPlaneUsers.id, userId),
              eq(controlPlaneUsers.enabled, true),
            ),
          )
          .get();
        if (!user) return false;
        const result = tx
          .update(controlPlaneAuthFlows)
          .set({ status: "consumed" })
          .where(
            and(
              eq(controlPlaneAuthFlows.id, id),
              eq(controlPlaneAuthFlows.status, "approved"),
              gt(controlPlaneAuthFlows.expiresAt, now),
            ),
          )
          .run();
        if (result.changes !== 1) return false;
        tx.insert(controlPlaneUserSessions)
          .values({ digest, userId, expiresAt })
          .run();
        return true;
      },
      { behavior: "immediate" },
    );
  }

  authenticate(digest: string, now: number) {
    return this.db
      .select({
        user: controlPlaneUsers,
        expiresAt: controlPlaneUserSessions.expiresAt,
      })
      .from(controlPlaneUserSessions)
      .innerJoin(
        controlPlaneUsers,
        eq(controlPlaneUserSessions.userId, controlPlaneUsers.id),
      )
      .where(
        and(
          eq(controlPlaneUserSessions.digest, digest),
          gt(controlPlaneUserSessions.expiresAt, now),
          eq(controlPlaneUsers.enabled, true),
        ),
      )
      .get();
  }

  revoke(digest: string) {
    this.db
      .delete(controlPlaneUserSessions)
      .where(eq(controlPlaneUserSessions.digest, digest))
      .run();
  }

  environmentState(
    userId: string,
    status: ControlPlaneUser["environmentStatus"],
  ) {
    return this.db
      .update(controlPlaneUsers)
      .set({ environmentStatus: status })
      .where(
        and(
          eq(controlPlaneUsers.id, userId),
          eq(controlPlaneUsers.enabled, true),
        ),
      )
      .returning()
      .get();
  }
}
