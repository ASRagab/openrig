// OPR.0.3.4.8 — POST /api/rigs/:rigId/cmux/launch.
// Replaces the sessionStatus=running label filter with actual tmux
// liveness via tmuxAdapter.hasSession. Adds bounded readiness wait
// for still-booting seats and honest partial response (opened vs
// missing with per-seat reasons).

import { Hono } from "hono";
import type { RigRepository } from "../domain/rig-repository.js";
import type { CmuxAdapter } from "../adapters/cmux.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { CmuxLayoutService } from "../domain/cmux-layout-service.js";

export const rigCmuxRoutes = new Hono();

interface NodeInventoryStubEntry {
  logicalId: string;
  canonicalSessionName: string | null;
  sessionStatus: string | null;
  attachmentType: string | null;
}

type NodeInventoryFn = (rigId: string) => NodeInventoryStubEntry[];

interface RigCmuxDeps {
  rigRepo: RigRepository;
  cmuxAdapter: CmuxAdapter;
  cmuxLayoutService: CmuxLayoutService;
  nodeInventoryFn: NodeInventoryFn;
  tmuxAdapter: TmuxAdapter;
}

function getDeps(c: { get: (key: string) => unknown }): RigCmuxDeps {
  return {
    rigRepo: c.get("rigRepo" as never) as RigRepository,
    cmuxAdapter: c.get("cmuxAdapter" as never) as CmuxAdapter,
    cmuxLayoutService: c.get("cmuxLayoutService" as never) as CmuxLayoutService,
    nodeInventoryFn: c.get("nodeInventoryFn" as never) as NodeInventoryFn,
    tmuxAdapter: c.get("tmuxAdapter" as never) as TmuxAdapter,
  };
}

function pickNonCollidingName(baseName: string, existing: Set<string>): string {
  if (!existing.has(baseName)) return baseName;
  let suffix = 2;
  while (existing.has(`${baseName}-${suffix}`)) suffix += 1;
  return `${baseName}-${suffix}`;
}

const READINESS_POLL_MS = 500;
const READINESS_TIMEOUT_MS = 5_000;

interface MissingSeat {
  logicalId: string;
  reason: string;
}

rigCmuxRoutes.post("/launch", async (c) => {
  const rigId = c.req.param("rigId")!;
  const { rigRepo, cmuxAdapter, cmuxLayoutService, nodeInventoryFn, tmuxAdapter } = getDeps(c);

  const rigWithRelations = rigRepo.getRig(rigId);
  if (!rigWithRelations) {
    return c.json(
      {
        ok: false,
        error: "rig_not_found",
        message: `Rig "${rigId}" not found — can't launch cmux workspace — try: rig ps`,
      },
      404,
    );
  }

  if (!cmuxAdapter.isAvailable()) {
    return c.json(
      {
        ok: false,
        error: "cmux_unavailable",
        message:
          "cmux is not available on this host — can't launch workspace — install cmux from https://cmux.io and run: cmux ping",
      },
      503,
    );
  }

  const inventory = nodeInventoryFn(rigId);

  // OPR.0.3.4.8: discriminate on ACTUAL tmux liveness, not the status label.
  // A seat is attachable iff it has a canonicalSessionName, is tmux-compatible,
  // and tmuxAdapter.hasSession(name) is true (the session is actually alive).
  // Dead/stale names (hasSession false) are NEVER attached — preserving the
  // safety invariant from the original running-only filter.
  const launchableByLogical = new Map<string, string>();
  const missing: MissingSeat[] = [];

  // Collect candidates: seats with a tmux-compatible canonical name.
  const candidates: Array<{ logicalId: string; sessionName: string }> = [];
  for (const entry of inventory) {
    if (!entry.canonicalSessionName) {
      missing.push({ logicalId: entry.logicalId, reason: "no-session" });
      continue;
    }
    if (entry.attachmentType != null && entry.attachmentType !== "tmux") {
      missing.push({ logicalId: entry.logicalId, reason: "non-tmux" });
      continue;
    }
    candidates.push({ logicalId: entry.logicalId, sessionName: entry.canonicalSessionName });
  }

  // Bounded readiness wait: for each candidate, check tmux liveness.
  // Poll still-booting seats until live or timeout. If a full poll
  // cycle finds zero new live sessions, stop early (no point waiting
  // for sessions that are consistently dead).
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  const pending = new Map(candidates.map((c) => [c.logicalId, c.sessionName]));
  let firstPass = true;

  while (pending.size > 0 && Date.now() < deadline) {
    let foundThisCycle = 0;
    for (const [logicalId, sessionName] of [...pending]) {
      try {
        const alive = await tmuxAdapter.hasSession(sessionName);
        if (alive) {
          launchableByLogical.set(logicalId, sessionName);
          pending.delete(logicalId);
          foundThisCycle++;
        }
      } catch {
        // Probe failed — treat as not-yet-live this cycle.
      }
    }
    if (pending.size === 0) break;
    // After the first pass, if no NEW sessions became live this cycle,
    // the remaining pending are consistently dead — stop early instead
    // of polling dead sessions for the full timeout.
    if (!firstPass && foundThisCycle === 0) break;
    firstPass = false;
    if (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, READINESS_POLL_MS));
    }
  }

  // Any still-pending after timeout -> missing with reason.
  for (const [logicalId] of pending) {
    missing.push({ logicalId, reason: "still-booting" });
  }

  // rig.nodes is in DB ORDER BY created_at — deterministic agent ordering.
  const orderedSessions: string[] = [];
  for (const node of rigWithRelations.nodes) {
    const session = launchableByLogical.get(node.logicalId);
    if (session) orderedSessions.push(session);
  }

  if (orderedSessions.length === 0) {
    const rigName = (rigWithRelations.rig as unknown as { name: string }).name;
    return c.json(
      {
        ok: false,
        error: "rig_not_running",
        message: `Rig "${rigName}" has no live tmux sessions — can't attach to anything — run: rig up ${rigName}`,
        missing,
      },
      412,
    );
  }

  const listResult = await cmuxAdapter.listWorkspaces();
  const existingNames = new Set<string>(
    listResult.ok ? listResult.data.map((w) => w.name) : [],
  );

  const chunks = CmuxLayoutService.chunkAgents(orderedSessions);
  const baseName = (rigWithRelations.rig as unknown as { name: string }).name;
  const workspaces: Array<{ name: string; agents: string[]; blanks: number }> = [];

  for (let i = 0; i < chunks.length; i++) {
    const desired = i === 0 ? baseName : `${baseName}-${i + 1}`;
    const name = pickNonCollidingName(desired, existingNames);
    existingNames.add(name);

    const build = await cmuxLayoutService.buildWorkspace(name, undefined, chunks[i]!);
    if (!build.ok) {
      return c.json(
        {
          ok: false,
          error: "build_workspace_failed",
          message: build.message,
          partial: workspaces,
        },
        500,
      );
    }
    workspaces.push({
      name: build.data.workspaceName,
      agents: build.data.agents,
      blanks: build.data.blanks,
    });
  }

  return c.json({
    ok: true,
    workspaces,
    ...(missing.length > 0 ? { missing } : {}),
  });
});
