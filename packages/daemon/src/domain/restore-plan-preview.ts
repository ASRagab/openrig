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
 *  classification (OPR.0.3.4.2) without touching anything. */
function intendedActionFor(rows: PreviewSessionRow[]): { intendedAction: RestorePlanPreviewNode["intendedAction"]; reason?: string } {
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

export function buildRestorePlanPreview(
  rig: RigWithRelations,
  snapshot: Snapshot | null,
  sessionRows: PreviewSessionRow[],
): RestorePlanPreview {
  const byNode = new Map<string, PreviewSessionRow[]>();
  for (const row of sessionRows) {
    (byNode.get(row.nodeId) ?? byNode.set(row.nodeId, []).get(row.nodeId)!).push(row);
  }
  const nodes: RestorePlanPreviewNode[] = rig.nodes.map((node) => {
    const { intendedAction, reason } = intendedActionFor(byNode.get(node.id) ?? []);
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
