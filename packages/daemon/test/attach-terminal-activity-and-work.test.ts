// Slice 15 — `attachTerminalActivityAndWork` non-inference test pack.
//
// HG-3 (both directions) + HG-4 (non-inference contract) at the
// per-node enrichment level. The ps-projection counts are derived from
// these fields, but the UI + `rig ps --json` also need per-node
// visibility — this test pack pins that surface.
//
// Discriminator pattern (per banked feedback_specific_review_recommendations_get_acted_on):
//   - DIRECTION A: active + no work → terminalActive=true, hasAssignedWork=false
//   - DIRECTION B: silent + queued work → terminalActive=false, hasAssignedWork=true
//   BOTH must pass — that's what proves the two primitives are computed
//   independently. Either alone is symmetry-breakable.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import {
  attachTerminalActivityAndWork,
  getNodeInventory,
} from "../src/domain/node-inventory.js";

function seedRig(db: Database.Database, name: string): string {
  const id = `rig-${name}`;
  db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(id, name);
  return id;
}
function seedNode(db: Database.Database, rigId: string, logicalId: string): string {
  const id = `node-${rigId}-${logicalId}`;
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)").run(id, rigId, logicalId);
  return id;
}
function seedSession(db: Database.Database, nodeId: string, sessionName: string, status = "running"): void {
  const id = `sess-${nodeId}-${Date.now()}-${Math.random()}`;
  db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, nodeId, sessionName, status, new Date().toISOString().replace("T", " ").slice(0, 19));
}
function seedPendingQitem(db: Database.Database, destinationSession: string, body = "test-body"): void {
  const id = `q-${Date.now()}-${Math.random()}`;
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  db.prepare(`
    INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, body)
    VALUES (?, ?, ?, ?, ?, 'pending', 'routine', 'routine', ?)
  `).run(id, ts, ts, "op@test", destinationSession, body);
}

function makeSeatActivityFor(activeBySession: Record<string, boolean | null>) {
  return {
    getSeatActivity: (paneId: string) => {
      if (!(paneId in activeBySession)) return null;
      const isActive = activeBySession[paneId]!;
      if (isActive === null) return null;
      return {
        paneId,
        isActiveWithinWindow: isActive,
        silenceWindowSeconds: 3,
        lastObservedAt: "2026-05-16T00:00:00.000Z",
      };
    },
  };
}

describe("attachTerminalActivityAndWork — slice 15 per-node enrichment", () => {
  let db: Database.Database;
  beforeEach(() => { db = createFullTestDb(); });
  afterEach(() => { db.close(); });

  it("HG-3 DIRECTION A — node producing output with NOTHING queued: terminalActive=true, hasAssignedWork=false", () => {
    const rig = seedRig(db, "active-only");
    const n = seedNode(db, rig, "dev");
    seedSession(db, n, "dev@rig", "running");

    const baseEntries = getNodeInventory(db, rig);
    const seatActivity = makeSeatActivityFor({ "dev@rig": true });
    const [entry] = attachTerminalActivityAndWork(baseEntries, { db, seatActivity: seatActivity as never });

    expect(entry!.terminalActive).toBe(true);
    expect(entry!.hasAssignedWork).toBe(false);
    expect(entry!.pendingWorkCount).toBe(0);
  });

  it("HG-3 DIRECTION B — node SILENT with queued work: terminalActive=false, hasAssignedWork=true", () => {
    const rig = seedRig(db, "work-only");
    const n = seedNode(db, rig, "dev");
    seedSession(db, n, "dev@rig", "running");
    seedPendingQitem(db, "dev@rig");

    const baseEntries = getNodeInventory(db, rig);
    const seatActivity = makeSeatActivityFor({ "dev@rig": false });
    const [entry] = attachTerminalActivityAndWork(baseEntries, { db, seatActivity: seatActivity as never });

    expect(entry!.terminalActive).toBe(false);
    expect(entry!.hasAssignedWork).toBe(true);
    expect(entry!.pendingWorkCount).toBe(1);
  });

  it("HG-4 non-inference — flipping ONLY activity does not move hasAssignedWork; flipping ONLY queue does not move terminalActive", () => {
    const rig = seedRig(db, "non-inf");
    const n = seedNode(db, rig, "dev");
    seedSession(db, n, "dev@rig", "running");
    const baseEntries = getNodeInventory(db, rig);

    // (a) silent + no work
    let seatActivity = makeSeatActivityFor({ "dev@rig": false });
    let [entry] = attachTerminalActivityAndWork(baseEntries, { db, seatActivity: seatActivity as never });
    expect(entry!.terminalActive).toBe(false);
    expect(entry!.hasAssignedWork).toBe(false);

    // (b) flip ONLY queue (add pending qitem); activity input unchanged.
    //     terminalActive MUST hold steady, hasAssignedWork MUST flip true.
    seedPendingQitem(db, "dev@rig");
    [entry] = attachTerminalActivityAndWork(getNodeInventory(db, rig), { db, seatActivity: seatActivity as never });
    expect(entry!.terminalActive).toBe(false); // unchanged ⟹ no queue→active inference
    expect(entry!.hasAssignedWork).toBe(true);

    // (c) flip ONLY activity (active observation); queue input unchanged.
    //     hasAssignedWork MUST hold steady, terminalActive MUST flip true.
    seatActivity = makeSeatActivityFor({ "dev@rig": true });
    [entry] = attachTerminalActivityAndWork(getNodeInventory(db, rig), { db, seatActivity: seatActivity as never });
    expect(entry!.terminalActive).toBe(true);
    expect(entry!.hasAssignedWork).toBe(true); // unchanged ⟹ no active→hasWork inference
  });

  it("no SeatActivity observation → terminalActive=null (distinct from false)", () => {
    const rig = seedRig(db, "no-obs");
    const n = seedNode(db, rig, "dev");
    seedSession(db, n, "dev@rig", "running");

    const baseEntries = getNodeInventory(db, rig);
    const seatActivity = { getSeatActivity: () => null };
    const [entry] = attachTerminalActivityAndWork(baseEntries, { db, seatActivity: seatActivity as never });

    // null ≠ false: consumers must treat "no signal" distinctly from
    // "definitely idle" so a non-tmux seat doesn't read as idle.
    expect(entry!.terminalActive).toBeNull();
    expect(entry!.hasAssignedWork).toBe(false);
  });

  it("no seatActivity service wired → terminalActive=undefined (the field is absent, not a value claim)", () => {
    const rig = seedRig(db, "no-svc");
    const n = seedNode(db, rig, "dev");
    seedSession(db, n, "dev@rig", "running");

    const baseEntries = getNodeInventory(db, rig);
    const [entry] = attachTerminalActivityAndWork(baseEntries, { db });

    expect(entry!.terminalActive).toBeUndefined();
    expect(entry!.hasAssignedWork).toBe(false); // queue check still runs
  });

  it("multiple pending qitems for one seat ⟹ hasAssignedWork=true, pendingWorkCount = N", () => {
    const rig = seedRig(db, "multi");
    const n = seedNode(db, rig, "dev");
    seedSession(db, n, "dev@rig", "running");
    seedPendingQitem(db, "dev@rig");
    seedPendingQitem(db, "dev@rig");
    seedPendingQitem(db, "dev@rig");

    const baseEntries = getNodeInventory(db, rig);
    const [entry] = attachTerminalActivityAndWork(baseEntries, { db });
    expect(entry!.hasAssignedWork).toBe(true);
    expect(entry!.pendingWorkCount).toBe(3);
  });

  it("non-pending qitems do NOT count toward pendingWorkCount", () => {
    const rig = seedRig(db, "states");
    const n = seedNode(db, rig, "dev");
    seedSession(db, n, "dev@rig", "running");
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    // pending: counts
    seedPendingQitem(db, "dev@rig");
    // done: doesn't count
    db.prepare(`
      INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, body)
      VALUES ('q-done', ?, ?, 'op@test', 'dev@rig', 'done', 'routine', 'routine', 'body')
    `).run(ts, ts);
    // blocked: doesn't count (only 'pending' is unworked-and-claimable)
    db.prepare(`
      INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, body)
      VALUES ('q-blocked', ?, ?, 'op@test', 'dev@rig', 'blocked', 'routine', 'routine', 'body')
    `).run(ts, ts);

    const [entry] = attachTerminalActivityAndWork(getNodeInventory(db, rig), { db });
    expect(entry!.pendingWorkCount).toBe(1);
    expect(entry!.hasAssignedWork).toBe(true);
  });
});
