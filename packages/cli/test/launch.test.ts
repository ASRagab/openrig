// OPR.0.3.4.11 — CLI rig launch --seats tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { launchCommand } from "../src/commands/launch.js";

function mockClient(responses: Record<string, { status: number; data: unknown }>) {
  return {
    post: vi.fn(async (url: string, body: unknown) => {
      for (const [pattern, resp] of Object.entries(responses)) {
        if (url.includes(pattern)) return resp;
      }
      return { status: 404, data: { ok: false, error: "not found" } };
    }),
    get: vi.fn(async () => ({ status: 200, data: {} })),
  };
}

function makeDeps(clientResponses: Record<string, { status: number; data: unknown }>) {
  const client = mockClient(clientResponses);
  return {
    lifecycleDeps: {
      spawn: vi.fn(),
      fetch: vi.fn(async () => ({ ok: true })),
      kill: vi.fn(() => true),
      readFile: vi.fn(() => JSON.stringify({ pid: 1, port: 3000, db: "t.sqlite", startedAt: new Date().toISOString() })),
      writeFile: vi.fn(),
      removeFile: vi.fn(),
      exists: vi.fn(() => true),
      mkdirp: vi.fn(),
      openForAppend: vi.fn(() => 1),
      isProcessAlive: vi.fn(() => true),
    },
    clientFactory: () => client,
    _client: client,
  };
}

describe("rig launch --seats", () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...args) => { logs.push(args.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...args) => { errors.push(args.join(" ")); });
    process.exitCode = undefined;
  });

  it("posts to launch-subset with seats array and holdReason", async () => {
    const deps = makeDeps({
      "launch-subset": {
        status: 201,
        data: {
          ok: true,
          launched: [
            { nodeId: "n1", logicalId: "dev.driver", status: "fresh" },
            { nodeId: "n2", logicalId: "dev.guard", status: "fresh" },
          ],
          held: [],
          alreadyRunning: [],
          failedTargets: [],
        },
      },
    });

    const cmd = launchCommand(deps);
    await cmd.parseAsync(["node", "rig", "rig-1", "--seats", "dev.driver,dev.guard", "--hold-reason", "codex auth expired"]);

    expect(deps._client.post).toHaveBeenCalledWith(
      "/api/rigs/rig-1/nodes/launch-subset",
      { seats: ["dev.driver", "dev.guard"], holdReason: "codex auth expired" },
    );
    expect(logs.some((l) => l.includes("dev.driver"))).toBe(true);
    expect(logs.some((l) => l.includes("dev.guard"))).toBe(true);
  });

  it("reports held and failedTargets honestly in human output", async () => {
    const deps = makeDeps({
      "launch-subset": {
        status: 201,
        data: {
          ok: true,
          launched: [{ nodeId: "n1", logicalId: "dev.driver", status: "fresh" }],
          held: [{ nodeId: "n2", logicalId: "dev.guard", reason: "codex auth expired" }],
          alreadyRunning: [],
          failedTargets: [{ nodeId: "n3", logicalId: "dev.reviewer", reason: "tmux_probe_error" }],
        },
      },
    });

    const cmd = launchCommand(deps);
    await cmd.parseAsync(["node", "rig", "rig-1", "--seats", "dev.driver,dev.guard,dev.reviewer"]);

    expect(logs.some((l) => l.includes("Launched") && l.includes("dev.driver"))).toBe(true);
    expect(logs.some((l) => l.includes("Held") && l.includes("dev.guard") && l.includes("codex auth expired"))).toBe(true);
    expect(errors.some((l) => l.includes("Failed") && l.includes("dev.reviewer"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("requires nodeRef or --seats", async () => {
    const deps = makeDeps({});
    const cmd = launchCommand(deps);
    await cmd.parseAsync(["node", "rig", "rig-1"]);

    expect(errors.some((l) => l.includes("--seats"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("single-target already_running prints honest message, not Launched", async () => {
    const deps = makeDeps({
      "/launch": {
        status: 200,
        data: {
          ok: true,
          rigId: "rig-1",
          nodeId: "n1",
          logicalId: "dev.driver",
          code: "already_running",
          alreadyRunning: [{ nodeId: "n1", logicalId: "dev.driver" }],
          launched: [],
          held: [],
        },
      },
    });

    const cmd = launchCommand(deps);
    await cmd.parseAsync(["node", "rig", "rig-1", "dev.driver"]);

    expect(logs.some((l) => l.includes("already running"))).toBe(true);
    expect(logs.some((l) => l.includes("Launched"))).toBe(false);
  });

  it("reports unmatchedIds in --seats mode", async () => {
    const deps = makeDeps({
      "launch-subset": {
        status: 201,
        data: {
          ok: true,
          launched: [{ nodeId: "n1", logicalId: "dev.driver", status: "fresh" }],
          held: [],
          alreadyRunning: [],
          failedTargets: [],
          unmatchedIds: ["typo.seat"],
        },
      },
    });

    const cmd = launchCommand(deps);
    await cmd.parseAsync(["node", "rig", "rig-1", "--seats", "dev.driver,typo.seat"]);

    expect(errors.some((l) => l.includes("Unmatched") && l.includes("typo.seat"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });
});
