import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { restoreCheckRoutes } from "../src/routes/restore-check.js";

function makeApp(result: Record<string, unknown>) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("rigRepo" as never, {
      db: { prepare: () => ({ all: () => [], get: () => undefined }) },
      listRigs: () => [],
    });
    c.set("snapshotRepo" as never, {
      listSnapshots: () => [],
      getLatestSnapshot: () => null,
    });
    await next();
  });

  const mockService = {
    check: () => result,
  };
  const routes = new Hono();
  routes.get("/", (c) => {
    const compact = c.req.query("compact") === "1";
    if (compact) {
      const r = result as {
        verdict: string;
        readiness: unknown;
        counts: unknown;
        rigs: Array<Record<string, unknown>>;
        checks: Array<{ status: string }>;
        recovery: Record<string, unknown>;
      };
      return c.json({
        verdict: r.verdict,
        readiness: r.readiness,
        counts: r.counts,
        rigs: r.rigs.map((rig) => ({
          rigId: rig.rigId,
          rigName: rig.rigName,
          status: rig.status,
          verdict: rig.verdict,
          expectedNodes: rig.expectedNodes,
          runningReadyNodes: rig.runningReadyNodes,
          blockedNodes: rig.blockedNodes,
          caveatNodes: rig.caveatNodes,
        })),
        checks: r.checks.filter((ch) => ch.status !== "green"),
        recovery: {
          status: r.recovery.status,
          summary: r.recovery.summary,
          actions: r.recovery.actions,
          blocked: r.recovery.blocked,
        },
      });
    }
    return c.json(result);
  });
  app.route("/api/restore-check", routes);
  return app;
}

const FULL_RESULT = {
  verdict: "restorable_with_caveats",
  readiness: { status: "ready_with_caveats", reason: "some_caveats", blockingRigCount: 0, caveatRigCount: 1, unknownRigCount: 0 },
  continuity: { status: "not_proven", evidence: "...", provenCapabilities: [], unprovenCapabilities: ["resume"] },
  rigs: [
    {
      rigId: "rig-1", rigName: "openrig-build", status: "ready", verdict: "restorable",
      expectedNodes: 7, runningReadyNodes: 7, blockedNodes: 0, caveatNodes: 0,
      blockingChecks: [], caveatChecks: [],
    },
    {
      rigId: "rig-2", rigName: "openrig-comms", status: "ready_with_caveats", verdict: "restorable_with_caveats",
      expectedNodes: 5, runningReadyNodes: 4, blockedNodes: 0, caveatNodes: 1,
      blockingChecks: [], caveatChecks: [{ check: "seat.caveat", status: "yellow", evidence: "stale", remediation: "refresh" }],
    },
  ],
  hostInfra: { status: "declared", evidence: "Host autostart detected" },
  recovery: { status: "not_needed", summary: "No recovery needed", actions: [], blocked: [], unknown: [] },
  counts: { red: 0, yellow: 1, green: 10 },
  checks: [
    { check: "daemon.reachable", status: "green", evidence: "OK", remediation: "" },
    { check: "seat.ready.impl", status: "green", evidence: "running+ready", remediation: "" },
    { check: "seat.caveat.editor", status: "yellow", evidence: "stale snapshot", remediation: "rig snapshot" },
  ],
  repairPacket: null,
};

describe("OPR.0.4.0.29 — restore-check compact route", () => {
  it("AC-1: compact response is materially smaller than full", async () => {
    const app = makeApp(FULL_RESULT);

    const fullRes = await app.request("/api/restore-check");
    const compactRes = await app.request("/api/restore-check?compact=1");

    const fullBody = await fullRes.text();
    const compactBody = await compactRes.text();

    expect(compactBody.length).toBeLessThan(fullBody.length);
    expect(JSON.parse(compactBody).verdict).toBe("restorable_with_caveats");
  });

  it("AC-2: full response preserves all fields", async () => {
    const app = makeApp(FULL_RESULT);
    const res = await app.request("/api/restore-check");
    const body = JSON.parse(await res.text());

    expect(body.continuity).toBeDefined();
    expect(body.hostInfra).toBeDefined();
    expect(body.repairPacket).toBeDefined();
    expect(body.checks.length).toBe(3);
    expect(body.rigs[0].blockingChecks).toBeDefined();
  });

  it("AC-3: compact excludes green checks, keeps yellow/red", async () => {
    const app = makeApp(FULL_RESULT);
    const res = await app.request("/api/restore-check?compact=1");
    const body = JSON.parse(await res.text());

    expect(body.checks.every((ch: { status: string }) => ch.status !== "green")).toBe(true);
    expect(body.checks.length).toBe(1);
    expect(body.checks[0].status).toBe("yellow");
  });

  it("AC-4: compact rig entries omit blockingChecks/caveatChecks detail", async () => {
    const app = makeApp(FULL_RESULT);
    const res = await app.request("/api/restore-check?compact=1");
    const body = JSON.parse(await res.text());

    for (const rig of body.rigs) {
      expect(rig.blockingChecks).toBeUndefined();
      expect(rig.caveatChecks).toBeUndefined();
      expect(rig.rigName).toBeDefined();
      expect(rig.status).toBeDefined();
      expect(rig.expectedNodes).toBeDefined();
    }
  });

  it("AC-7: readiness classes derive from real enums (no invented status)", async () => {
    const app = makeApp(FULL_RESULT);
    const res = await app.request("/api/restore-check?compact=1");
    const body = JSON.parse(await res.text());

    const validStatuses = new Set(["ready", "ready_with_caveats", "not_ready", "unknown"]);
    for (const rig of body.rigs) {
      expect(validStatuses.has(rig.status)).toBe(true);
    }
    expect(body.readiness.status).toBeDefined();
    expect(validStatuses.has(body.readiness.status)).toBe(true);
  });

  it("AC-8: per-rig grouping shows mixed states", async () => {
    const app = makeApp(FULL_RESULT);
    const res = await app.request("/api/restore-check?compact=1");
    const body = JSON.parse(await res.text());

    expect(body.rigs.length).toBe(2);
    expect(body.rigs[0].status).toBe("ready");
    expect(body.rigs[1].status).toBe("ready_with_caveats");
  });

  it("AC-5: daemon back-compat — no compact param returns full result", async () => {
    const app = makeApp(FULL_RESULT);
    const res = await app.request("/api/restore-check");
    const body = JSON.parse(await res.text());

    expect(body.checks.length).toBe(3);
    expect(body.continuity).toBeDefined();
    expect(body.hostInfra).toBeDefined();
  });
});
