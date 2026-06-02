// Slice-21 FR-5 — workspace doctor readiness checks for `rig workspace doctor`.
//
// 7 checks (this commit ships #1; #2-#7 land in follow-on commits in
// this same chain):
//   1. Workspace root reachable (env > file > default precedence)
//   2. Missions folder present
//   3. File allowlist sane
//   4. Daemon points at this workspace
//   5. Daemon reload needed
//   6. Optional slice docs (warn-only)
//   7. MISSION_NOTES presence
//
// Per-check return shape is `{check, status: "ok"|"warn"|"fail",
// message, fixHint?, evidence?}` per FR-5 IMPL-PRD §76-78. The shape
// diverges intentionally from the install-health `rig doctor`'s
// DoctorCheck shape (pass|warn|fail|skipped, reason/fix) — different
// concerns warrant different schemas (workspace-readiness vs install-
// health); the divergence is orch-marshal-accepted per cont.43-followup.

import * as fs from "node:fs";

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  check: string;
  status: CheckStatus;
  message: string;
  fixHint?: string;
  evidence?: Record<string, unknown>;
}

export type WorkspaceRootSource = "env" | "file" | "default";

export interface CheckWorkspaceRootInput {
  workspaceRoot: string;
  source: WorkspaceRootSource;
}

const ENV_FIX_HINT =
  "unset OPENRIG_WORKSPACE_ROOT or set it to an existing directory; run `rig config init-workspace` to scaffold a fresh one";
const FILE_FIX_HINT =
  "update workspace.root in config.json to an existing directory; run `rig config init-workspace` to scaffold a fresh one";
const DEFAULT_FIX_HINT =
  "run `rig config init-workspace` to scaffold the default workspace at the configured root";

function fixHintForSource(source: WorkspaceRootSource): string {
  switch (source) {
    case "env":
      return ENV_FIX_HINT;
    case "file":
      return FILE_FIX_HINT;
    case "default":
      return DEFAULT_FIX_HINT;
  }
}

/**
 * Check #1 — workspace root reachable.
 *
 * Verifies the resolved workspace root exists as a directory. The
 * `source` (env / file / default) is propagated into the fix-hint so
 * the operator gets the right remediation channel.
 */
export function checkWorkspaceRootReachable(opts: CheckWorkspaceRootInput): DoctorCheck {
  const { workspaceRoot, source } = opts;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(workspaceRoot);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      check: "workspace_root_reachable",
      status: "fail",
      message: code === "ENOENT"
        ? `workspace root '${workspaceRoot}' does not exist (resolved from ${source})`
        : `workspace root '${workspaceRoot}' is not reachable: ${(err as Error).message}`,
      fixHint: fixHintForSource(source),
      evidence: { workspaceRoot, source, errorCode: code ?? "unknown" },
    };
  }
  if (!stat.isDirectory()) {
    return {
      check: "workspace_root_reachable",
      status: "fail",
      message: `workspace root '${workspaceRoot}' exists but is not a directory (resolved from ${source})`,
      fixHint: fixHintForSource(source),
      evidence: { workspaceRoot, source, kind: "not_a_directory" },
    };
  }
  return {
    check: "workspace_root_reachable",
    status: "ok",
    message: `workspace root '${workspaceRoot}' is a reachable directory`,
    evidence: { workspaceRoot, source },
  };
}
