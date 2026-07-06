// OPR.0.4.4.19 FR-9 — scope approve: frontmatter sole-writer + append-only
// audit row. Includes the plan-review QA guardrail: an audit-write failure
// can NEVER leave a trusted half-stamp (frontmatter restored, loud error) —
// and NO audit row is ever deleted (the arch-lead ordering pin).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlAuditBrowse } from "../src/domain/mission-control/audit-browse.js";
import { ScopeApproveError, ScopeApproveService } from "../src/domain/scope/scope-approve.js";

describe("ScopeApproveService (OPR.0.4.4.19 FR-9)", () => {
  let db: Database.Database;
  let actionLog: MissionControlActionLog;
  let auditBrowse: MissionControlAuditBrowse;
  let missionsRoot: string;
  let sliceDir: string;
  let readmePath: string;

  function service(overrides?: { actionLog?: MissionControlActionLog }): ScopeApproveService {
    return new ScopeApproveService({
      missionsRoot: () => missionsRoot,
      actionLog: overrides?.actionLog ?? actionLog,
    });
  }

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, queueItemsSchema, missionControlActionsSchema]);
    actionLog = new MissionControlActionLog(db);
    auditBrowse = new MissionControlAuditBrowse(db);
    missionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scope-approve-"));
    sliceDir = path.join(missionsRoot, "release-x", "slices", "19-signal-layer");
    fs.mkdirSync(sliceDir, { recursive: true });
    readmePath = path.join(sliceDir, "README.md");
    fs.writeFileSync(readmePath, "---\nid: OPR.X.19\nstatus: building\n---\n\n# The slice\nbody prose stays intact\n");
  });

  afterEach(() => {
    db.close();
    fs.rmSync(missionsRoot, { recursive: true, force: true });
  });

  function frontmatterOf(p: string): Record<string, unknown> {
    const m = /^---\s*\n([\s\S]*?)\n---/.exec(fs.readFileSync(p, "utf8"));
    return m ? (YAML.parse(m[1]!) as Record<string, unknown>) : {};
  }

  const baseInput = {
    scopeTier: "slice" as const,
    scopePath: "release-x/slices/19-signal-layer",
    approvalScope: "delivery" as const,
    actorSession: "human-review@kernel",
  };

  it("delivery approve writes approved-by/-at AND the audit row with the pinned target contract — both in one operation", () => {
    const result = service().approve(baseInput);
    const fm = frontmatterOf(readmePath);
    expect(fm["approved-by"]).toBe("human-review@kernel");
    expect(typeof fm["approved-at"]).toBe("string");
    // Body prose untouched.
    expect(fs.readFileSync(readmePath, "utf8")).toContain("body prose stays intact");
    // The audit row carries the pinned shape.
    const rows = auditBrowse.query({ scopeId: "OPR.X.19" }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actionVerb).toBe("approve");
    expect(rows[0]!.actorSession).toBe("human-review@kernel");
    expect(rows[0]!.qitemId).toBeNull();
    expect(rows[0]!.auditNotes).toMatchObject({
      kind: "scope-approval",
      scope_tier: "slice",
      scope_id: "OPR.X.19",
      scope_path: "release-x/slices/19-signal-layer",
      approval_scope: "delivery",
      on_behalf_of: null,
    });
    expect(result.freezeFired).toBe(false);
  });

  it("one-query lookup by scope target + approver + approval scope returns exactly the matching row", () => {
    service().approve({ ...baseInput, approvalScope: "spec" });
    service().approve(baseInput);
    // Unrelated action noise.
    actionLog.record({
      actionVerb: "annotate",
      qitemId: null,
      actorSession: "a@r",
      actedAt: new Date().toISOString(),
      annotation: "n",
    });
    const rows = auditBrowse.query({
      scopeTier: "slice",
      scopeId: "OPR.X.19",
      scopePath: "release-x/slices/19-signal-layer",
      approvalScope: "delivery",
      actorSession: "human-review@kernel",
    }).rows;
    expect(rows).toHaveLength(1);
    expect((rows[0]!.auditNotes as Record<string, unknown>).approval_scope).toBe("delivery");
  });

  it("hand-edited frontmatter with NO matching audit row: the cross-check query returns empty (the UNVERIFIED-stamp signal)", () => {
    fs.writeFileSync(readmePath, "---\nid: OPR.X.19\napproved-by: forged@nowhere\napproved-at: 2026-07-04T00:00:00Z\n---\n# s\n");
    const rows = auditBrowse.query({ scopeTier: "slice", scopeId: "OPR.X.19" }).rows;
    expect(rows).toHaveLength(0); // detectable from stored data alone
  });

  it("STAGED: --scope spec writes approved-spec-by/-at with approval_scope=spec; delivery afterwards is the normal staged sequence, not a re-stamp", () => {
    service().approve({ ...baseInput, approvalScope: "spec", actorSession: "pm-lead@openrig-pm" });
    let fm = frontmatterOf(readmePath);
    expect(fm["approved-spec-by"]).toBe("pm-lead@openrig-pm");
    expect(fm["approved-by"]).toBeUndefined();
    // Delivery stamp lands independently.
    service().approve(baseInput);
    fm = frontmatterOf(readmePath);
    expect(fm["approved-spec-by"]).toBe("pm-lead@openrig-pm");
    expect(fm["approved-by"]).toBe("human-review@kernel");
    const spec = auditBrowse.query({ scopeId: "OPR.X.19", approvalScope: "spec" }).rows;
    const delivery = auditBrowse.query({ scopeId: "OPR.X.19", approvalScope: "delivery" }).rows;
    expect(spec).toHaveLength(1);
    expect(delivery).toHaveLength(1);
  });

  it("re-approve at the SAME scope fails loudly naming the existing stamp", () => {
    service().approve(baseInput);
    expect(() => service().approve(baseInput)).toThrow(/already carries a delivery approval stamp/);
    try {
      service().approve(baseInput);
    } catch (err) {
      expect((err as ScopeApproveError).code).toBe("already_approved");
    }
    // Only ONE audit row exists.
    expect(auditBrowse.query({ scopeId: "OPR.X.19" }).rows).toHaveLength(1);
  });

  it("DELEGATED: --on-behalf-of keeps the REAL invoking session as actor; delegation lives in the audit notes", () => {
    service().approve({ ...baseInput, actorSession: "orch-advisor@openrig-delivery", onBehalfOf: "founder" });
    const fm = frontmatterOf(readmePath);
    expect(fm["approved-by"]).toBe("orch-advisor@openrig-delivery"); // honest provenance
    const rows = auditBrowse.query({ scopeId: "OPR.X.19" }).rows;
    expect(rows[0]!.actorSession).toBe("orch-advisor@openrig-delivery");
    expect((rows[0]!.auditNotes as Record<string, unknown>).on_behalf_of).toBe("founder");
    expect(rows[0]!.reason).toContain("on behalf of founder");
  });

  it("mission-tier approve has the same semantics", () => {
    const missionReadme = path.join(missionsRoot, "release-x", "README.md");
    fs.writeFileSync(missionReadme, "---\nid: OPR.X\n---\n# mission\n");
    service().approve({ scopeTier: "mission", scopePath: "release-x", approvalScope: "delivery", actorSession: "human@kernel" });
    expect(frontmatterOf(missionReadme)["approved-by"]).toBe("human@kernel");
    const rows = auditBrowse.query({ scopeTier: "mission", scopeId: "OPR.X" }).rows;
    expect(rows).toHaveLength(1);
  });

  it("QA GUARDRAIL: an audit-write failure restores the prior frontmatter and fails loudly — no trusted half-stamp, no deleted audit rows", () => {
    const failingLog = {
      record: () => { throw new Error("disk full"); },
    } as unknown as MissionControlActionLog;
    const before = fs.readFileSync(readmePath, "utf8");
    expect(() => service({ actionLog: failingLog }).approve(baseInput)).toThrow(/no half-stamp/);
    // Frontmatter byte-restored.
    expect(fs.readFileSync(readmePath, "utf8")).toBe(before);
    expect(frontmatterOf(readmePath)["approved-by"]).toBeUndefined();
    // And the failure path never wrote (or deleted) audit rows.
    expect(auditBrowse.query({ scopeId: "OPR.X.19" }).rows).toHaveLength(0);
  });

  it("guards: path escape, missing README, missing dot-ID", () => {
    expect(() => service().approve({ ...baseInput, scopePath: "../../etc" })).toThrow(ScopeApproveError);
    expect(() => service().approve({ ...baseInput, scopePath: "release-x/slices/nope" })).toThrow(/not a declared slice/);
    fs.writeFileSync(readmePath, "---\nstatus: building\n---\n# no id\n");
    expect(() => service().approve(baseInput)).toThrow(/no frontmatter id/);
  });
});
