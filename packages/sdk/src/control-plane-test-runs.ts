import { z } from "zod";
import {
  controlPlaneTestRunSchema,
  controlPlaneTestRunStartSchema,
  type ControlPlaneTestRunStart,
} from "@bb/domain";
export function createControlPlaneTestRunClient(
  request: (
    path: string,
    method: string,
    body?: object,
    signal?: AbortSignal,
  ) => Promise<unknown>,
  mode: "user" | "admin",
) {
  const base = `/control-plane/${mode}/test-runs`;
  return {
    async start(input: ControlPlaneTestRunStart, signal?: AbortSignal) {
      return controlPlaneTestRunSchema.parse(
        await request(
          base,
          "POST",
          controlPlaneTestRunStartSchema.parse(input),
          signal,
        ),
      );
    },
    async find(runId: string, signal?: AbortSignal) {
      return z
        .object({ testRun: controlPlaneTestRunSchema.nullable() })
        .strict()
        .parse(
          await request(
            `${base}/by-run/${encodeURIComponent(runId)}`,
            "GET",
            undefined,
            signal,
          ),
        );
    },
    async get(id: string, signal?: AbortSignal) {
      return controlPlaneTestRunSchema.parse(
        await request(
          `${base}/${encodeURIComponent(id)}`,
          "GET",
          undefined,
          signal,
        ),
      );
    },
  };
}
