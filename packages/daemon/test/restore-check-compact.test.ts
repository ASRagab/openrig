import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RestoreCheckService, type RestoreCheckDeps, type NodeInventoryEntry, type RestoreCheckResult } from "../src/domain/restore-check-service.js";

function makeReadyNode(logicalId: string): NodeInventoryEntry {
  return {
    logicalId,
    canonicalSessionName: `${logicalId.replace(".", "-")}@test-rig`,
    sessionStatus: "running",
    startupStatus: "ready",
    cwd: "/project",
    latestError: null,
    tmuxAttachCommand: `tmux attach -t ${logicalId.replace(".", "-")}@test-rig`,
  } as NodeInventoryEntry;
}

function makeNotReadyNode(logicalId: string): NodeInventoryEntry {
  return {
    logicalId,
    canonicalSessionName: `${logicalId.replace(".", "-")}@test-rig`,
    sessionStatus: "exited",
    startupStatus: "failed",
    cwd: "/project",
    latestError: "Startup failed",
  } as NodeInventoryEntry;
}

function makeDeps(nodes: NodeInventoryEntry[]): RestoreCheckDeps {
  return {
    listRigs: () => [{ rigId: "rig-1", name: "test-rig" }],
    getNodeInventory: () => nodes,
    getStartupContext: () => ({ status: "missing" as const, evidence: "no context" }),
    hasSnapshot: () => true,
    getLatestSnapshot: () => ({ id: "snap-1", kind: "full" }),
    probeDaemonHealth: () => ({ healthy: true, evidence: "OK" }),
    exists: () => false,
    readFile: () => "",
  };
}

describe("OPR.0.4.0.29 — restore-check compact via service", () => {
  it("AC-1: compact produces fewer checks than full", () => {
    const nodes = [
      makeReadyNode("dev.impl"),
      makeReadyNode("dev.qa"),
      makeReadyNode("dev.guard"),
      makeNotReadyNode("dev.design"),
    ];

    const service = new RestoreCheckService(makeDeps(nodes));
    const full = service.check({ compact: false });
    const compact = service.check({ compact: true });

    expect(compact.checks.length).toBeLessThan(full.checks.length);
    expect(compact.rigs.length).toBe(full.rigs.length);
  });

  it("AC-3: compact skips per-seat detail for ready seats (FR-3/AC-4)", () => {
    const nodes = [
      makeReadyNode("dev.impl"),
      makeReadyNode("dev.qa"),
      makeNotReadyNode("dev.design"),
    ];

    const service = new RestoreCheckService(makeDeps(nodes));
    const compact = service.check({ compact: true });
    const full = service.check({ compact: false });

    const compactSeatChecks = compact.checks.filter((c) => c.check.startsWith("seat."));
    const fullSeatChecks = full.checks.filter((c) => c.check.startsWith("seat."));
    expect(compactSeatChecks.length).toBeLessThan(fullSeatChecks.length);

    const notReadyCheck = compact.checks.find((c) => c.status === "red" && c.check.includes("readiness"));
    expect(notReadyCheck).toBeDefined();
    expect(notReadyCheck!.evidence).toContain("not running/ready");
  });

  it("AC-7: readiness classes derive from real enums", () => {
    const nodes = [makeReadyNode("dev.impl"), makeNotReadyNode("dev.qa")];
    const service = new RestoreCheckService(makeDeps(nodes));
    const result = service.check({});

    const validStatuses = new Set(["ready", "ready_with_caveats", "not_ready", "unknown"]);
    expect(validStatuses.has(result.readiness.status)).toBe(true);
    for (const rig of result.rigs) {
      expect(validStatuses.has(rig.status)).toBe(true);
    }
  });

  it("AC-5: no compact option = full result (back-compat)", () => {
    const nodes = [makeReadyNode("dev.impl")];
    const service = new RestoreCheckService(makeDeps(nodes));
    const result = service.check({});

    const seatChecks = result.checks.filter((c) => c.check.startsWith("seat.") || c.check.includes("startup_context") || c.check.includes("transcript") || c.check.includes("resume"));
    expect(seatChecks.length).toBeGreaterThan(1);
  });

  it("AC-8: per-rig grouping shows rig rollup", () => {
    const nodes = [makeReadyNode("dev.impl"), makeNotReadyNode("dev.qa")];
    const service = new RestoreCheckService(makeDeps(nodes));
    const result = service.check({});

    expect(result.rigs.length).toBe(1);
    expect(result.rigs[0]!.rigName).toBe("test-rig");
    expect(result.rigs[0]!.expectedNodes).toBe(2);
  });
});
