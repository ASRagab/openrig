// PL-007 Workspace Primitive v0 — workspace HTTP route tests.
//
// Pins:
//   - POST /api/workspace/validate returns the structured gap report
//   - 400 on missing root
//   - 400 on invalid workspace kind
//   - kind-agnostic invocation (no workspaceKind) returns 0 gaps when no
//     contract enforced

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { workspaceRoutes } from "../src/routes/workspace.js";

let dir: string;
let app: Hono;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pl007-route-"));
  app = new Hono();
  app.route("/api/workspace", workspaceRoutes());
});

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("workspace HTTP routes (PL-007)", () => {
  it("POST /validate returns structured gap report on knowledge canon", async () => {
    fs.writeFileSync(path.join(dir, "a.md"), "---\ndoc: a\nstatus: active\ncreated: 2026-05-04\nowner: x\n---\n", "utf-8");
    fs.writeFileSync(path.join(dir, "missing.md"), "---\ndoc: m\nstatus: active\ncreated: 2026-05-04\n---\n", "utf-8");
    const res = await app.request("/api/workspace/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: dir, workspaceKind: "knowledge" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { totalFiles: number; gapCount: number; gaps: Array<{ kind: string; field: string | null }> };
    expect(body.totalFiles).toBe(2);
    expect(body.gapCount).toBe(1);
    expect(body.gaps[0]?.field).toBe("owner");
  });

  it("POST /validate rejects missing root with 400", async () => {
    const res = await app.request("/api/workspace/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST /validate rejects unknown workspace kind", async () => {
    const res = await app.request("/api/workspace/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: dir, workspaceKind: "rd-pod" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /validate without workspaceKind runs structural-only check", async () => {
    fs.writeFileSync(path.join(dir, "a.md"), "---\ndoc: a\n---\n", "utf-8");
    const res = await app.request("/api/workspace/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: dir }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { gapCount: number; workspaceKind: string | null };
    expect(body.gapCount).toBe(0);
    expect(body.workspaceKind).toBeNull();
  });
});

// Slice-21 FR-5 — POST /api/workspace/doctor route tests.
//
// Wires a stub SettingsStore via Hono middleware (matching production
// pattern at server.ts:430 where `c.set("settingsStore", ...)`).
// SettingsStore is constructed with a temp config-file path so the
// suite doesn't touch ~/.openrig.
describe("workspace doctor HTTP route (slice-21 FR-5)", () => {
  let doctorDir: string;
  let doctorApp: Hono;
  let configPath: string;

  beforeEach(async () => {
    doctorDir = fs.mkdtempSync(path.join(os.tmpdir(), "fr5-route-"));
    // Build a healthy workspace shape under doctorDir.
    fs.mkdirSync(path.join(doctorDir, "missions", "getting-started"), { recursive: true });
    fs.writeFileSync(path.join(doctorDir, "missions", "getting-started", "MISSION_NOTES.md"), "");
    fs.mkdirSync(path.join(doctorDir, "missions", "getting-started", "slices", "s1"), { recursive: true });
    fs.writeFileSync(path.join(doctorDir, "missions", "getting-started", "slices", "s1", "README.md"), "");

    // Stub SettingsStore-shaped object — we only need the surface the
    // doctor route uses: resolveOne + configPath. SettingsStore's
    // public surface is large; the stub mirrors the resolveOne return
    // shape (value/source/defaultValue).
    configPath = path.join(doctorDir, ".test-config.json");
    fs.writeFileSync(configPath, "{}");
    const oldMtime = new Date(Date.now() - 60_000);
    fs.utimesSync(configPath, oldMtime, oldMtime);

    const stubStore = {
      configPath,
      resolveOne(key: string) {
        switch (key) {
          case "workspace.root":
            return { value: doctorDir, source: "env", defaultValue: doctorDir };
          case "workspace.slices_root":
            return { value: path.join(doctorDir, "missions"), source: "default", defaultValue: path.join(doctorDir, "missions") };
          case "files.allowlist":
            return { value: `workspace:${fs.realpathSync(doctorDir)}`, source: "default", defaultValue: `workspace:${doctorDir}` };
          default:
            return { value: "", source: "default", defaultValue: "" };
        }
      },
    };

    doctorApp = new Hono();
    doctorApp.use("*", async (c, next) => {
      c.set("settingsStore" as never, stubStore as never);
      await next();
    });
    doctorApp.route("/api/workspace", workspaceRoutes());
  });

  afterEach(() => {
    try { fs.rmSync(doctorDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("POST /doctor returns 200 with a 7-check DoctorReport on a healthy workspace", async () => {
    const res = await doctorApp.request("/api/workspace/doctor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      workspaceRoot: string;
      checks: Array<{ check: string; status: string }>;
      summary: { ok: number; warn: number; fail: number };
      daemonResolvedAt: string;
    };
    expect(body.workspaceRoot).toBe(doctorDir);
    expect(body.checks).toHaveLength(7);
    expect(body.summary.ok).toBe(7);
    expect(body.summary.warn).toBe(0);
    expect(body.summary.fail).toBe(0);
    expect(body.daemonResolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // Discriminator-flip: caller-supplied workspaceRoot must be honored.
  // Without the body.workspaceRoot branch the route would always check
  // the daemon-resolved workspace.
  it("POST /doctor honors body.workspaceRoot for the workspace under check", async () => {
    const altRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fr5-route-alt-"));
    try {
      const res = await doctorApp.request("/api/workspace/doctor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceRoot: altRoot }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as {
        workspaceRoot: string;
        checks: Array<{ check: string; status: string; evidence?: Record<string, unknown> }>;
        summary: { ok: number; warn: number; fail: number };
      };
      expect(body.workspaceRoot).toBe(altRoot);
      // Check #4 (daemon_points_at_this_workspace) must FAIL because
      // daemon's resolved root differs from the caller-supplied one.
      const daemonCheck = body.checks.find((c) => c.check === "daemon_points_at_this_workspace");
      expect(daemonCheck?.status).toBe("fail");
    } finally {
      fs.rmSync(altRoot, { recursive: true, force: true });
    }
  });

  // Discriminator-flip: 503 when SettingsStore is missing. Without
  // the `if (!store) return 503` guard the route would crash.
  it("POST /doctor returns 503 when settingsStore is unavailable", async () => {
    const bareApp = new Hono();
    bareApp.route("/api/workspace", workspaceRoutes());
    const res = await bareApp.request("/api/workspace/doctor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("settings_unavailable");
  });

  // Discriminator-flip: empty body must be tolerated. Without the
  // .catch(() => ({})) guard the JSON parse would throw and 500
  // would land instead of the report.
  it("POST /doctor tolerates empty body (no Content-Type, no JSON)", async () => {
    const res = await doctorApp.request("/api/workspace/doctor", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { workspaceRoot: string };
    expect(body.workspaceRoot).toBe(doctorDir);
  });
});
