// Slice 15 — SeatActivityService unit tests (TDD).
//
// The service is the daemon's owner of the `terminal-active` primitive.
// It polls tmux's per-pane silence flag at a configurable cadence and
// keeps the latest observation in memory keyed by canonical session
// name. Downstream consumers (ps-projection, node-inventory, UI hooks
// via the event stream) read through the service. The service does NOT
// touch queue/assignment state — that's the non-inference contract.

import { describe, it, expect, vi } from "vitest";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// Slice 15 — tmux adapter mock keyed by canonical session name.
// Map value: Unix epoch seconds of last activity (number), or null to
// simulate "no signal" (target missing or blank tmux output, e.g.
// tmux 3.6a behavior observed by velocity-qa).
function makeTmuxAdapter(
  lastActivityBySession: Record<string, number | null>,
): TmuxAdapter {
  return {
    readPaneLastActivity: vi.fn(async (paneId: string) => {
      return Object.prototype.hasOwnProperty.call(lastActivityBySession, paneId)
        ? lastActivityBySession[paneId]!
        : null;
    }),
  } as unknown as TmuxAdapter;
}

const FIXED_NOW = new Date("2026-05-16T10:00:00.000Z");
const FIXED_NOW_EPOCH = FIXED_NOW.getTime() / 1000;

describe("SeatActivityService", () => {
  it("pollSeat records ACTIVE observation when window_activity is within the silence window", async () => {
    // Activity 1s ago, window 3s → active
    const tmux = makeTmuxAdapter({ "claude@rig": FIXED_NOW_EPOCH - 1 });
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });

    const observed = await svc.pollSeat("claude@rig");

    expect(observed).not.toBeNull();
    expect(observed!.paneId).toBe("claude@rig");
    expect(observed!.isActiveWithinWindow).toBe(true);
    expect(observed!.silenceWindowSeconds).toBe(3);
    expect(observed!.lastObservedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("pollSeat records IDLE observation when window_activity is older than the silence window", async () => {
    // Activity 10s ago, window 5s → idle (10s ≥ 5s)
    const tmux = makeTmuxAdapter({ "claude@rig": FIXED_NOW_EPOCH - 10 });
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 5, now: () => FIXED_NOW });

    const observed = await svc.pollSeat("claude@rig");

    expect(observed!.isActiveWithinWindow).toBe(false);
    expect(observed!.silenceWindowSeconds).toBe(5);
  });

  it("HG-7 DISCRIMINATOR — same activity timestamp, different window: window=3 → idle; window=20 → active", async () => {
    // Last activity 10s ago. With a 3s window: idle. With a 20s window: active.
    const tmux = makeTmuxAdapter({ "claude@rig": FIXED_NOW_EPOCH - 10 });
    const tight = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });
    const loose = new SeatActivityService({ tmux, defaultWindowSeconds: 20, now: () => FIXED_NOW });

    const tightObs = await tight.pollSeat("claude@rig");
    const looseObs = await loose.pollSeat("claude@rig");

    expect(tightObs!.isActiveWithinWindow).toBe(false); // 10s > 3s
    expect(looseObs!.isActiveWithinWindow).toBe(true);  // 10s < 20s
  });

  it("pollSeat returns null when tmux read returns null (no observation; consumer treats as 'unknown')", async () => {
    const tmux = makeTmuxAdapter({ "claude@rig": null });
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3 });

    expect(await svc.pollSeat("claude@rig")).toBeNull();
  });

  it("getSeatActivity returns the latest stored observation for a seat", async () => {
    const tmux = makeTmuxAdapter({ "claude@rig": FIXED_NOW_EPOCH });
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });

    expect(svc.getSeatActivity("claude@rig")).toBeNull();
    await svc.pollSeat("claude@rig");

    const stored = svc.getSeatActivity("claude@rig");
    expect(stored).not.toBeNull();
    expect(stored!.isActiveWithinWindow).toBe(true);
  });

  it("getSeatActivity is keyed per-seat; observations don't leak across seats", async () => {
    // a is idle (60s old), b is active (current)
    const tmux = makeTmuxAdapter({
      "a@rig": FIXED_NOW_EPOCH - 60,
      "b@rig": FIXED_NOW_EPOCH,
    });
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });

    await svc.pollSeat("a@rig");
    await svc.pollSeat("b@rig");

    expect(svc.getSeatActivity("a@rig")!.isActiveWithinWindow).toBe(false);
    expect(svc.getSeatActivity("b@rig")!.isActiveWithinWindow).toBe(true);
  });

  it("pollSeat with a per-seat override honors the override; default is the fallback", async () => {
    // Activity 5s ago. Default window 3s → idle. Override 10s → active.
    const tmux = makeTmuxAdapter({ "claude@rig": FIXED_NOW_EPOCH - 5 });
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });

    const observed = await svc.pollSeat("claude@rig", { silenceWindowSeconds: 10 });
    expect(observed!.silenceWindowSeconds).toBe(10);
    expect(observed!.isActiveWithinWindow).toBe(true); // 5s < 10s

    const observed2 = await svc.pollSeat("claude@rig"); // no override → default 3s
    expect(observed2!.silenceWindowSeconds).toBe(3);
    expect(observed2!.isActiveWithinWindow).toBe(false); // 5s > 3s
  });

  it("absorbs tmux errors so polling failures never crash the daemon loop", async () => {
    const tmux = {
      readPaneLastActivity: vi.fn(async () => {
        throw new Error("tmux gone");
      }),
    } as unknown as TmuxAdapter;
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3 });

    await expect(svc.pollSeat("claude@rig")).resolves.toBeNull();
  });

  // Slice 15 non-inference contract (HG-4 partial): the service has no
  // input port for queue/assignment state. Even at the type level, the
  // constructor must NOT accept a queue repo / projection. If a future
  // contributor reaches for queue data here, this constructor-shape
  // test fails compile, surfacing the regression.
  it("HG-4 partial — constructor surface depends only on tmux + cadence (no queue/assignment input)", () => {
    const tmux = makeTmuxAdapter({});
    // The constructor only accepts `tmux` + `defaultWindowSeconds` (+ optional bus).
    // If we tried to pass any queue/assignment-shaped dep the compile fails.
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3 });
    expect(svc).toBeDefined();
  });

  describe("pollAllRunningTmuxSeats", () => {
    // Uses the same DB schema the daemon uses — pick up the test-app
    // helper that provisions an in-memory daemon DB with all migrations.
    async function makeDb() {
      const { createFullTestDb } = await import("./helpers/test-app.js");
      return createFullTestDb();
    }

    it("polls every running tmux-bound seat once; stores observations keyed by canonical session name", async () => {
      const db = await makeDb();
      try {
        db.prepare("INSERT INTO rigs (id, name) VALUES ('r1', 'rig-a')").run();
        db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n1', 'r1', 'dev')").run();
        db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n2', 'r1', 'qa')").run();
        const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
        db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
          .run("s1", "n1", "dev@rig", "running", ts);
        db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
          .run("s2", "n2", "qa@rig", "running", ts);

        const tmux = makeTmuxAdapter({
          "dev@rig": FIXED_NOW_EPOCH,         // active (now)
          "qa@rig": FIXED_NOW_EPOCH - 60,     // idle (60s old, window 3s)
        });
        const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });

        await svc.pollAllRunningTmuxSeats(db);

        expect(svc.getSeatActivity("dev@rig")!.isActiveWithinWindow).toBe(true);
        expect(svc.getSeatActivity("qa@rig")!.isActiveWithinWindow).toBe(false);
        expect(tmux.readPaneLastActivity).toHaveBeenCalledTimes(2);
      } finally {
        db.close();
      }
    });

    it("skips detached / stopped seats — only `running` status is polled", async () => {
      const db = await makeDb();
      try {
        db.prepare("INSERT INTO rigs (id, name) VALUES ('r1', 'rig-a')").run();
        db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n1', 'r1', 'dev')").run();
        db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n2', 'r1', 'qa')").run();
        const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
        db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
          .run("s1", "n1", "dev@rig", "running", ts);
        db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
          .run("s2", "n2", "qa@rig", "detached", ts);

        const tmux = makeTmuxAdapter({
          "dev@rig": FIXED_NOW_EPOCH,
          "qa@rig": FIXED_NOW_EPOCH,
        });
        const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });
        await svc.pollAllRunningTmuxSeats(db);

        expect(svc.getSeatActivity("dev@rig")).not.toBeNull();
        expect(svc.getSeatActivity("qa@rig")).toBeNull(); // detached → skipped
        expect(tmux.readPaneLastActivity).toHaveBeenCalledTimes(1);
      } finally {
        db.close();
      }
    });

    it("drops cached observations for seats no longer in the running set (memory hygiene)", async () => {
      const db = await makeDb();
      try {
        db.prepare("INSERT INTO rigs (id, name) VALUES ('r1', 'rig-a')").run();
        db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n1', 'r1', 'dev')").run();
        const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
        db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
          .run("s1", "n1", "dev@rig", "running", ts);

        const tmux = makeTmuxAdapter({ "dev@rig": FIXED_NOW_EPOCH });
        const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3 });
        await svc.pollAllRunningTmuxSeats(db);
        expect(svc.getSeatActivity("dev@rig")).not.toBeNull();

        // Stop the seat; expect the observation to drop on next sweep.
        db.prepare("UPDATE sessions SET status = 'detached' WHERE id = 's1'").run();
        await svc.pollAllRunningTmuxSeats(db);
        expect(svc.getSeatActivity("dev@rig")).toBeNull();
      } finally {
        db.close();
      }
    });
  });
});
