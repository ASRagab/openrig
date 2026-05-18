// Slice 09 — rig-policy HTTP route tests.
//
// HG-4 + HG-SAFE anchored at the route layer:
//   - PUT/DELETE require operator bearer when configured (HG-4 — agent
//     path cannot mutate).
//   - PUT validates the record through the same store validator; an
//     auto-accept posture is rejected (HG-SAFE runtime defense).
//   - GET endpoints are open (within the daemon's existing posture).
//   - resolveEffective returns more-specific binding (HG-3).
//   - source grep: route file contains no permission-allowlist / auth
//     / tmux / lifecycle identifier (HG-SAFE source-level).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigPolicyStore } from "../src/domain/rig-policy/rig-policy-store.js";
import { rigPolicyRoutes } from "../src/routes/rig-policy.js";
import type { OperatorContextModeRecord } from "../src/domain/rig-policy/rig-policy-types.js";

function makeRecord(overrides?: Partial<OperatorContextModeRecord>): OperatorContextModeRecord {
  return {
    mode: "debug",
    autonomy_scope: "bounded_continuation",
    heartbeat_cadence: "fast",
    inspection_depth: "forensic",
    update_detail: "verbose",
    escalation_threshold: "low",
    concurrency_limit: "serial",
    permission_prompt_posture: "normal",
    scope: "qitem",
    expiry_or_stale_rule: "re_confirm_on_long_gap",
    evidence_citation: "operator confirmed debug",
    ...overrides,
  };
}

function buildApp(db: Database.Database, bearer: string | null): { app: Hono; store: RigPolicyStore } {
  const store = new RigPolicyStore(db);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("rigPolicyStore" as never, store);
    await next();
  });
  app.route("/api/rig-policy", rigPolicyRoutes({ bearerToken: bearer }));
  return { app, store };
}

describe("rig-policy HTTP routes — slice 09", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createFullTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("GET /defaults returns the 6×7 + default-scope + DEFAULT_STALE_RULE", async () => {
    const { app } = buildApp(db, null);
    const res = await app.request("/api/rig-policy/defaults");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      recommendedModeDefaults: Record<string, unknown>;
      recommendedDefaultScope: Record<string, string>;
      defaultStaleRule: string;
    };
    expect(Object.keys(body.recommendedModeDefaults).sort()).toEqual(["away", "debug", "desk", "focus", "mobile", "sleep"]);
    expect(body.recommendedDefaultScope.debug).toBe("qitem");
    expect(body.defaultStaleRule).toBe("re_confirm_on_long_gap");
  });

  it("HG-4: PUT requires the operator bearer when configured", async () => {
    const { app } = buildApp(db, "operator-token");
    const res = await app.request("/api/rig-policy/bindings/qitem/q-1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeRecord()),
    });
    expect(res.status).toBe(401);
  });

  it("HG-4: PUT accepts a valid record with the correct bearer; round-trips via GET", async () => {
    const { app } = buildApp(db, "operator-token");
    const put = await app.request("/api/rig-policy/bindings/qitem/q-1", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer operator-token",
      },
      body: JSON.stringify(makeRecord()),
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { binding: { setBy: string; record: { mode: string } } };
    expect(putBody.binding.setBy).toBe("operator");
    expect(putBody.binding.record.mode).toBe("debug");

    const get = await app.request("/api/rig-policy/bindings/qitem/q-1");
    expect(get.status).toBe(200);
    const getBody = (await get.json()) as { binding: { record: { mode: string } } };
    expect(getBody.binding.record.mode).toBe("debug");
  });

  it("HG-SAFE: PUT with permission_prompt_posture='auto_accept' is rejected (runtime defense)", async () => {
    const { app } = buildApp(db, null);
    const res = await app.request("/api/rig-policy/bindings/qitem/q-1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...makeRecord(), permission_prompt_posture: "auto_accept" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; errors?: string[] };
    expect(body.error).toBe("validation_failed");
    expect(body.errors?.some((e) => e.includes("permission_prompt_posture"))).toBe(true);
  });

  it("HG-3 effective-resolution: qitem wins over global_host", async () => {
    const { app, store } = buildApp(db, null);
    store.setBinding("global_host", null, makeRecord({ mode: "sleep", scope: "global_host" }));
    store.setBinding("qitem", "q-1", makeRecord({ mode: "debug", scope: "qitem" }));

    const r1 = await app.request("/api/rig-policy/effective?qitem=q-1");
    expect(r1.status).toBe(200);
    const r1body = (await r1.json()) as { effective: { resolvedScope: string; binding: { record: { mode: string } } }; posture: string };
    expect(r1body.effective.resolvedScope).toBe("qitem");
    expect(r1body.effective.binding.record.mode).toBe("debug");
    expect(r1body.posture).toBe("known");

    const r2 = await app.request("/api/rig-policy/effective?qitem=q-other");
    const r2body = (await r2.json()) as { effective: { resolvedScope: string; binding: { record: { mode: string } } } };
    expect(r2body.effective.resolvedScope).toBe("global_host");
    expect(r2body.effective.binding.record.mode).toBe("sleep");
  });

  it("Q6 unknown_posture: GET /effective with no matching binding returns null + unknown_posture", async () => {
    const { app } = buildApp(db, null);
    const res = await app.request("/api/rig-policy/effective?qitem=q-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { effective: unknown; posture: string };
    expect(body.effective).toBeNull();
    expect(body.posture).toBe("unknown_posture");
  });

  it("GET /bindings returns all bindings", async () => {
    const { app, store } = buildApp(db, null);
    store.setBinding("global_host", null, makeRecord({ mode: "sleep", scope: "global_host" }));
    store.setBinding("rig", "rig-a", makeRecord({ mode: "focus", scope: "rig" }));
    const res = await app.request("/api/rig-policy/bindings");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bindings: Array<{ id: string }> };
    expect(body.bindings.map((b) => b.id).sort()).toEqual(["global_host:host", "rig:rig-a"]);
  });

  it("HG-4: DELETE requires operator bearer when configured", async () => {
    const { app, store } = buildApp(db, "operator-token");
    store.setBinding("rig", "rig-a", makeRecord({ scope: "rig" }));
    const noAuth = await app.request("/api/rig-policy/bindings/rig/rig-a", { method: "DELETE" });
    expect(noAuth.status).toBe(401);
    const auth = await app.request("/api/rig-policy/bindings/rig/rig-a", {
      method: "DELETE",
      headers: { authorization: "Bearer operator-token" },
    });
    expect(auth.status).toBe(200);
    const body = (await auth.json()) as { removed: boolean };
    expect(body.removed).toBe(true);
  });

  it("scope_invalid rejects unknown scope at the route layer", async () => {
    const { app } = buildApp(db, null);
    const res = await app.request("/api/rig-policy/bindings/banana/x", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeRecord()),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("scope_invalid");
  });

  it("qualifier_required: GET /bindings/rig (no qualifier) returns 400", async () => {
    const { app } = buildApp(db, null);
    const res = await app.request("/api/rig-policy/bindings/rig");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("qualifier_required");
  });

  it("GET /bindings/global_host (no qualifier) reads the host binding", async () => {
    const { app, store } = buildApp(db, null);
    store.setBinding("global_host", null, makeRecord({ mode: "sleep", scope: "global_host" }));
    const res = await app.request("/api/rig-policy/bindings/global_host");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { binding: { record: { mode: string } } };
    expect(body.binding.record.mode).toBe("sleep");
  });

  it("404 on a missing binding", async () => {
    const { app } = buildApp(db, null);
    const res = await app.request("/api/rig-policy/bindings/rig/rig-not-there");
    expect(res.status).toBe(404);
  });

  // HG-SAFE source-level — the route file does NOT reference permission
  // allowlist / runtime config / tmux / lifecycle identifiers. The route
  // is purely a binding-related surface (HG-SAFE).
  it("HG-SAFE: rig-policy route source contains no permission / auth-token / tmux / lifecycle identifiers", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.join(here, "..", "src", "routes", "rig-policy.ts"),
      "utf-8",
    );
    for (const forbidden of [
      "permissionAllowlist",
      "permission_allowlist",
      "runtimeConfig",
      "runtime_config",
      "tmuxAdapter",
      "tmux_session",
      "session_transport",
      "auth_token",
    ]) {
      expect(src.includes(forbidden)).toBe(false);
    }
  });
});
