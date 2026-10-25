import { gzipSync } from "node:zlib";
import { turnScope, type ThreadEvent } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  groupHostDaemonEvents,
  type HostDaemonEventEnvelope,
  ungroupHostDaemonEvents,
} from "../src/session.js";

interface PayloadSize {
  gzipBytes: number;
  jsonBytes: number;
}

function payloadSize(value: unknown): PayloadSize {
  const json = JSON.stringify(value);
  return {
    gzipBytes: gzipSync(json).byteLength,
    jsonBytes: Buffer.byteLength(json),
  };
}

function event(index: number): ThreadEvent {
  return {
    type: "item/agentMessage/delta",
    threadId: "thr_payload_measurement_123456789",
    providerThreadId: "provider_payload_measurement_123456789",
    scope: turnScope("turn_payload_measurement_123456789"),
    itemId: "item_payload_measurement_123456789",
    delta: `streamed token chunk ${index} `,
  };
}

describe("daemon-to-server event payload sizes", () => {
  it("preserves event order when a thread recurs after another thread", () => {
    const envelopes: HostDaemonEventEnvelope[] = [
      { threadId: "thr_a", event: event(1) },
      { threadId: "thr_b", event: event(2) },
      { threadId: "thr_a", event: event(3) },
    ];

    const groups = groupHostDaemonEvents(envelopes);

    expect(groups.map((group) => group.threadId)).toEqual([
      "thr_a",
      "thr_b",
      "thr_a",
    ]);
    expect(ungroupHostDaemonEvents(groups)).toEqual(envelopes);
  });

  it("records legacy-envelope and grouped sizes across representative batches", () => {
    const measurements = [1, 10, 50].map((eventCount) => {
      const events: HostDaemonEventEnvelope[] = Array.from(
        { length: eventCount },
        (_, index) => ({
          threadId: "thr_payload_measurement_123456789",
          event: event(index),
        }),
      );
      const legacyPayload = {
        sessionId: "session_payload_measurement_123456789",
        events,
      };
      const groupedPayload = {
        sessionId: "session_payload_measurement_123456789",
        eventGroups: groupHostDaemonEvents(events),
      };
      return {
        eventCount,
        legacyEnvelope: payloadSize(legacyPayload),
        grouped: payloadSize(groupedPayload),
      };
    });

    expect(
      measurements.map((entry) => ({
        eventCount: entry.eventCount,
        legacyJsonBytes: entry.legacyEnvelope.jsonBytes,
        groupedJsonBytes: entry.grouped.jsonBytes,
      })),
    ).toEqual([
      { eventCount: 1, legacyJsonBytes: 413, groupedJsonBytes: 421 },
      { eventCount: 10, legacyJsonBytes: 3554, groupedJsonBytes: 3049 },
      { eventCount: 50, legacyJsonBytes: 17554, groupedJsonBytes: 14769 },
    ]);
    for (const entry of measurements) {
      expect(entry.legacyEnvelope.gzipBytes).toBeLessThan(
        entry.legacyEnvelope.jsonBytes / 2,
      );
      expect(entry.grouped.gzipBytes).toBeLessThan(entry.grouped.jsonBytes / 2);
      expect(entry.grouped.gzipBytes).toBeLessThanOrEqual(
        entry.legacyEnvelope.gzipBytes + 16,
      );
    }

    for (const measurement of measurements.slice(1)) {
      expect(measurement.grouped.jsonBytes).toBeLessThan(
        measurement.legacyEnvelope.jsonBytes,
      );
    }
  });
});
