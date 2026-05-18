// Slice 09 — Rig Policy (operator context mode) HTTP routes.
//
// Surface (binding-related ONLY — HG-SAFE):
//   GET    /api/rig-policy/bindings                      — list bindings
//   GET    /api/rig-policy/bindings/:scope/:qualifier?   — read one binding
//   PUT    /api/rig-policy/bindings/:scope/:qualifier?   — upsert (operator)
//   DELETE /api/rig-policy/bindings/:scope/:qualifier?   — unset (operator)
//   GET    /api/rig-policy/effective                     — resolve effective
//                                                          (?rig=&workstream=&qitem=)
//   GET    /api/rig-policy/defaults                      — recommended
//                                                          per-mode 6×7
//                                                          + default scope
//                                                          + DEFAULT_STALE_RULE
//
// Authority (HG-4): write verbs (PUT / DELETE) require the daemon's
// operator bearer (same posture as mission-control). Reads are open
// (within the daemon's existing loopback/tailnet/bearer model). There
// is NO agent-set code path — the route mounts the bearer middleware
// on write verbs only; agents calling read endpoints must use the same
// auth the daemon already enforces at the listen layer.
//
// HG-SAFE preserved: this router NEVER touches permission allowlists /
// runtime configs / auth tokens / tmux / lifecycle. It calls a single
// store (RigPolicyStore) whose surface area is itself binding-limited.

import { Hono } from "hono";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import type { RigPolicyStore } from "../domain/rig-policy/rig-policy-store.js";
import {
  OPERATOR_CONTEXT_SCOPES,
  type OperatorContextScope,
} from "../domain/rig-policy/rig-policy-types.js";
import {
  DEFAULT_STALE_RULE,
  RECOMMENDED_DEFAULT_SCOPE,
  RECOMMENDED_MODE_DEFAULTS,
} from "../domain/rig-policy/rig-policy-defaults.js";

export interface RigPolicyRoutesOpts {
  /** Operator bearer token (same one Mission Control uses). When null,
   * the daemon's listen layer is loopback-only and write verbs pass
   * through; non-null requires `Authorization: Bearer <token>`. */
  bearerToken?: string | null;
}

const VALID_SCOPES = new Set<string>(OPERATOR_CONTEXT_SCOPES);

function parseScope(raw: string): OperatorContextScope | null {
  return VALID_SCOPES.has(raw) ? (raw as OperatorContextScope) : null;
}

function getStore(c: { get: (key: string) => unknown }): RigPolicyStore | null {
  const store = c.get("rigPolicyStore" as never) as RigPolicyStore | undefined;
  return store ?? null;
}

export function rigPolicyRoutes(opts?: RigPolicyRoutesOpts): Hono {
  const router = new Hono();
  const bearer = opts?.bearerToken ?? null;
  const requireOperator = authBearerTokenMiddleware({ expectedToken: bearer });

  // -- read: defaults --------------------------------------------------
  router.get("/defaults", (c) => {
    return c.json({
      recommendedModeDefaults: RECOMMENDED_MODE_DEFAULTS,
      recommendedDefaultScope: RECOMMENDED_DEFAULT_SCOPE,
      defaultStaleRule: DEFAULT_STALE_RULE,
    });
  });

  // -- read: list ------------------------------------------------------
  router.get("/bindings", (c) => {
    const store = getStore(c);
    if (!store) return c.json({ error: "rig_policy_store_unavailable" }, 503);
    return c.json({ bindings: store.listBindings() });
  });

  // -- read: resolveEffective ------------------------------------------
  router.get("/effective", (c) => {
    const store = getStore(c);
    if (!store) return c.json({ error: "rig_policy_store_unavailable" }, 503);
    const rigId = c.req.query("rig") || undefined;
    const workstreamId = c.req.query("workstream") || undefined;
    const qitemId = c.req.query("qitem") || undefined;
    const resolved = store.resolveEffective({ rigId, workstreamId, qitemId });
    // Q6 — null = unknown_posture; do NOT silently default. Surface to caller.
    if (!resolved) {
      return c.json({
        effective: null,
        posture: "unknown_posture",
        hint: "No binding matches this read context. Per convention §Q6 callers MUST treat this as unknown_posture (do not default to desk).",
      });
    }
    return c.json({ effective: resolved, posture: "known" });
  });

  // -- read: one binding (qualifier path-optional via /:scope or /:scope/:qualifier)
  router.get("/bindings/:scope/:qualifier?", (c) => {
    const store = getStore(c);
    if (!store) return c.json({ error: "rig_policy_store_unavailable" }, 503);
    const scope = parseScope(c.req.param("scope"));
    if (!scope) {
      return c.json({
        error: "scope_invalid",
        hint: `Unknown scope. Allowed: ${OPERATOR_CONTEXT_SCOPES.join(", ")}.`,
      }, 400);
    }
    const qualifierRaw = c.req.param("qualifier");
    const qualifier = scope === "global_host" ? null : (qualifierRaw ?? null);
    if (scope !== "global_host" && (qualifier === null || qualifier.length === 0)) {
      return c.json({
        error: "qualifier_required",
        hint: `Scope ${scope} requires a qualifier (rigId / workstreamId / qitemId).`,
      }, 400);
    }
    const binding = store.getBinding(scope, qualifier);
    if (!binding) return c.json({ error: "not_found" }, 404);
    return c.json({ binding });
  });

  // -- write: upsert (operator-only) -----------------------------------
  router.put("/bindings/:scope/:qualifier?", requireOperator, async (c) => {
    const store = getStore(c);
    if (!store) return c.json({ error: "rig_policy_store_unavailable" }, 503);
    const scope = parseScope(c.req.param("scope"));
    if (!scope) {
      return c.json({
        error: "scope_invalid",
        hint: `Unknown scope. Allowed: ${OPERATOR_CONTEXT_SCOPES.join(", ")}.`,
      }, 400);
    }
    const qualifierRaw = c.req.param("qualifier");
    const qualifier = scope === "global_host" ? null : (qualifierRaw ?? null);
    const body = await c.req.json().catch(() => null);
    if (body === null || typeof body !== "object") {
      return c.json({
        error: "body_required",
        hint: "PUT body must be the 10-field OperatorContextModeRecord (JSON object).",
      }, 400);
    }
    const result = store.setBinding(scope, qualifier, (body as { record?: unknown }).record ?? body);
    if (!result.ok) {
      return c.json({ error: "validation_failed", errors: result.errors }, 400);
    }
    return c.json({ binding: result.binding });
  });

  // -- write: delete (operator-only) -----------------------------------
  router.delete("/bindings/:scope/:qualifier?", requireOperator, (c) => {
    const store = getStore(c);
    if (!store) return c.json({ error: "rig_policy_store_unavailable" }, 503);
    const scope = parseScope(c.req.param("scope"));
    if (!scope) {
      return c.json({
        error: "scope_invalid",
        hint: `Unknown scope. Allowed: ${OPERATOR_CONTEXT_SCOPES.join(", ")}.`,
      }, 400);
    }
    const qualifierRaw = c.req.param("qualifier");
    const qualifier = scope === "global_host" ? null : (qualifierRaw ?? null);
    const removed = store.deleteBinding(scope, qualifier);
    return c.json({ removed });
  });

  return router;
}
