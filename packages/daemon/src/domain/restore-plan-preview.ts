// OPR.0.3.4.4 — read-only restore plan preview.
//
// `rig up --existing <rig> --plan` advertised "preview without executing" but
// the rig_name path bypassed the plan gate and MUTATED (recreated sessions,
// flipped detached->running, replaced manually-resumed panes). This module is
// the shared read-only preview both restore routes (`/api/up` rig_name and the
// Explorer `/api/rigs/:id/up`) return when plan=true: it computes the INTENDED
// per-seat restore action from snapshot/session data and touches NOTHING — no
// restoreOrchestrator.restore(), no session create/kill/replace/resume, no
// snapshot capture (the auto-rehydrate capture is itself a mutation and is
// only reported as would-happen), no projection writes.

import type Database from "better-sqlite3";
import type { RigWithRelations, Snapshot } from "./types.js";

export interface RestorePlanPreviewNode {
  logicalId: string;
  /** The slice-02 vocabulary, as a forecast: what apply mode WOULD do. */
  intendedAction: "resume-original" | "fresh-primed" | "awaiting-decision";
  reason?: string;
}

export interface RestorePlanPreview {
  status: "plan";
  mode: "restore";
  rigId: string;
  rigName: string;
  /** The snapshot apply mode would restore from (null when it would capture
   *  a current-state auto-rehydrate snapshot instead). */
  snapshot: { id: string; kind: string; createdAt: string } | null;
  /** True when apply mode would first CAPTURE an auto-rehydrate snapshot —
   *  reported, not performed (plan mode performs zero writes). */
  wouldCaptureCurrentState: boolean;
  nodes: RestorePlanPreviewNode[];
  /** Always false — the contract this preview exists to keep. */
  mutated: false;
}

export interface PreviewSessionRow {
  nodeId: string;
  restorePolicy: string | null;
  resumeType: string | null;
  resumeToken: string | null;
  /** ULID-ordered id so the newest session per node wins (matches the
   *  orchestrator's latest-session selection). */
  id: string;
}

/** Forecast one seat's restore action — mirrors the orchestrator's pre-launch
 *  classification (OPR.0.3.4.2) without touching anything. A fresh-listed
 *  seat (operation B, `--fresh <seat>`) forecasts `fresh-primed` BEFORE any
 *  resume-token logic, exactly as apply mode deliberately skips the resume. */
function intendedActionFor(rows: PreviewSessionRow[], freshRequested: boolean): { intendedAction: RestorePlanPreviewNode["intendedAction"]; reason?: string } {
  if (freshRequested) {
    return {
      intendedAction: "fresh-primed",
      reason: "listed in --fresh — apply would deliberately skip the resume (operation B)",
    };
  }
  const latest = rows.length > 0 ? rows.reduce((a, b) => (b.id > a.id ? b : a)) : null;
  const policy = latest?.restorePolicy ?? "resume_if_possible";
  const sourceRecorded = !!latest?.resumeType && latest.resumeType !== "none";
  if (policy === "resume_if_possible" && sourceRecorded && latest?.resumeToken) {
    return { intendedAction: "resume-original" };
  }
  if (policy === "resume_if_possible" && sourceRecorded && !latest?.resumeToken) {
    return {
      intendedAction: "awaiting-decision",
      reason: `resume source '${latest?.resumeType}' recorded but no token available — apply would stop and ask (zero session)`,
    };
  }
  return { intendedAction: "fresh-primed" };
}

/** Gather the session rows the preview forecasts from — the snapshot's
 *  captured sessions when one exists, otherwise the live rows an
 *  auto-rehydrate capture WOULD snapshot (read-only SELECT; the capture
 *  itself is a mutation and is never performed here). */
export function collectPreviewSessionRows(
  db: Database.Database,
  rig: RigWithRelations,
  snapshot: Snapshot | null,
): PreviewSessionRow[] {
  if (snapshot) {
    return (snapshot.data.sessions ?? []).map((s) => ({
      nodeId: s.nodeId,
      restorePolicy: s.restorePolicy ?? null,
      resumeType: s.resumeType ?? null,
      resumeToken: s.resumeToken ?? null,
      id: s.id,
    }));
  }
  const nodeIds = rig.nodes.map((n) => n.id);
  if (nodeIds.length === 0) return [];
  const placeholders = nodeIds.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, node_id, restore_policy, resume_type, resume_token FROM sessions WHERE node_id IN (${placeholders})`
  ).all(...nodeIds) as Array<{ id: string; node_id: string; restore_policy: string | null; resume_type: string | null; resume_token: string | null }>;
  return rows.map((r) => ({
    nodeId: r.node_id,
    restorePolicy: r.restore_policy,
    resumeType: r.resume_type,
    resumeToken: r.resume_token,
    id: r.id,
  }));
}

export function buildRestorePlanPreview(
  rig: RigWithRelations,
  snapshot: Snapshot | null,
  sessionRows: PreviewSessionRow[],
  freshLogicalIds?: string[],
): RestorePlanPreview {
  const byNode = new Map<string, PreviewSessionRow[]>();
  for (const row of sessionRows) {
    (byNode.get(row.nodeId) ?? byNode.set(row.nodeId, []).get(row.nodeId)!).push(row);
  }
  const nodes: RestorePlanPreviewNode[] = rig.nodes.map((node) => {
    const freshRequested = freshLogicalIds?.includes(node.logicalId) ?? false;
    const { intendedAction, reason } = intendedActionFor(byNode.get(node.id) ?? [], freshRequested);
    return { logicalId: node.logicalId, intendedAction, ...(reason ? { reason } : {}) };
  });
  return {
    status: "plan",
    mode: "restore",
    rigId: rig.rig.id,
    rigName: rig.rig.name,
    snapshot: snapshot ? { id: snapshot.id, kind: snapshot.kind, createdAt: snapshot.createdAt } : null,
    wouldCaptureCurrentState: snapshot === null,
    nodes,
    mutated: false,
  };
}
