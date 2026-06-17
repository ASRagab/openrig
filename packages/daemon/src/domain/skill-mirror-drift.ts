import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SOURCE_DIR = resolve(REPO_ROOT, "packages/daemon/specs/agents/shared/skills");
const TARGET_DIR = resolve(REPO_ROOT, "skills/_canonical");

const EXCLUDES = [
  "feedback.md",
  "evals/",
  ".DS_Store",
  "*.local.md",
];

function parseChanges(output: string): string[] {
  return output.split("\n").filter(Boolean).filter(
    (line) => /^[<>ch][fdLDS]/.test(line.slice(0, 2)) || line.startsWith("*deleting "),
  );
}

export type MirrorDriftSafeResult =
  | { ok: true; stale: boolean; changes: string[] }
  | { ok: false; reason: string };

export function checkMirrorDriftSafe(exec: typeof execFileSync = execFileSync): MirrorDriftSafeResult {
  if (!existsSync(SOURCE_DIR)) {
    return { ok: false, reason: `Mirror source not found: ${SOURCE_DIR}` };
  }
  if (!existsSync(TARGET_DIR)) {
    return { ok: false, reason: `Mirror target not found: ${TARGET_DIR}` };
  }

  try {
    const args = [
      "-a", "--delete", "--delete-excluded", "--itemize-changes",
      "-n", "--checksum",
      ...EXCLUDES.map((p) => `--exclude=${p}`),
      SOURCE_DIR + "/",
      TARGET_DIR + "/",
    ];
    const output = exec("rsync", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    const changes = parseChanges(output as string);
    return { ok: true, stale: changes.length > 0, changes };
  } catch (err) {
    return { ok: false, reason: `rsync failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
