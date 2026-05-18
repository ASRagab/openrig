// PL-007 Workspace Primitive v0 — `rig workspace` CLI surface.
//
// v0 surface (one verb): `rig workspace validate`. Walks a workspace root,
// parses each .md file's YAML frontmatter, and emits a structured gap
// report. Advisory only — never modifies. curate-steward consumes the
// report.

import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import * as path from "node:path";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export interface WorkspaceDeps extends StatusDeps {}

interface ValidationGap {
  filePath: string;
  relativePath: string;
  kind: string;
  field: string | null;
  message: string;
  workspaceKind: string | null;
}

interface ValidationReport {
  root: string;
  workspaceKind: string | null;
  totalFiles: number;
  filesWithFrontmatter: number;
  gapCount: number;
  gaps: ValidationGap[];
}

async function withClient<T>(
  deps: WorkspaceDeps,
  fn: (client: DaemonClient) => Promise<T>,
): Promise<T | undefined> {
  const status = await getDaemonStatus(deps.lifecycleDeps);
  if (status.state !== "running" || status.healthy === false) {
    console.error("Daemon not running. Start it with: rig daemon start");
    process.exitCode = 1;
    return undefined;
  }
  const client = deps.clientFactory(getDaemonUrl(status));
  return fn(client);
}

// release-0.3.2 slice 01 BC repair — strict-int validator for
// --max-files. Rejects `12abc`, `abc`, `0`, `-1`, etc. with a 3-part
// fact/consequence/action error; does NOT call the daemon on invalid
// input. Keeps positive cases (`10000`, `12`, etc.) flowing through.
export function parseMaxFilesStrict(raw: string): number {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    const err = new Error(
      `--max-files must be a positive integer (got "${raw}").`,
    ) as Error & { fact: string; consequence: string; action: string };
    err.fact = `--max-files must be a positive integer (got "${raw}").`;
    err.consequence = "rig workspace validate did not run; daemon was not contacted.";
    err.action = "Pass a positive integer like --max-files 10000.";
    throw err;
  }
  return Number.parseInt(raw, 10);
}

function emit3PartError(json: boolean, fact: string, consequence: string, action: string): void {
  if (json) {
    console.log(JSON.stringify({ ok: false, error: { fact, consequence, action } }, null, 2));
  } else {
    process.stderr.write(`Error: ${fact}\n${consequence}\n${action}\n`);
  }
  process.exitCode = 1;
}

export function workspaceCommand(depsOverride?: WorkspaceDeps): Command {
  const cmd = new Command("workspace").description(
    "PL-007 Workspace Primitive — typed-kind tooling. v0: `validate` walks a root and reports frontmatter gaps.",
  );

  const getDeps = (): WorkspaceDeps =>
    depsOverride ?? {
      lifecycleDeps: realDeps(),
      clientFactory: (url: string) => new DaemonClient(url),
    };

  cmd
    .command("validate [root]")
    .description(
      "Walk a workspace root, parse each .md file's YAML frontmatter, and emit a structured gap report. Advisory only — never modifies files. Default root: cwd.",
    )
    .option("--kind <kind>", "Workspace kind to validate against: user | project | knowledge | lab | delivery")
    .option("--no-recursive", "Do not descend into subdirectories")
    .option("--require-frontmatter", "Report a gap for every .md file without a frontmatter delimiter")
    .option("--max-files <n>", "Hard cap on .md files walked", "10000")
    .option("--json", "JSON output for agents")
    .action(
      async (
        rootArg: string | undefined,
        opts: {
          kind?: string;
          recursive?: boolean;
          requireFrontmatter?: boolean;
          maxFiles: string;
          json?: boolean;
        },
      ) => {
        // HG-6 — CLI-side validation BEFORE the daemon call. Reject
        // malformed --max-files with a 3-part error; never silently
        // coerce `12abc` → 12.
        let maxFiles: number;
        try {
          maxFiles = parseMaxFilesStrict(opts.maxFiles);
        } catch (err) {
          const e = err as Error & { fact?: string; consequence?: string; action?: string };
          emit3PartError(Boolean(opts.json), e.fact ?? e.message, e.consequence ?? "", e.action ?? "");
          return;
        }
        const root = path.resolve(rootArg ?? process.cwd());
        const deps = getDeps();
        await withClient(deps, async (client) => {
          const res = await client.post<ValidationReport>("/api/workspace/validate", {
            root,
            workspaceKind: opts.kind,
            recursive: opts.recursive !== false,
            requireFrontmatter: opts.requireFrontmatter ?? false,
            maxFiles,
          });
          if (res.status >= 400) {
            console.error(JSON.stringify(res.data, null, 2));
            process.exitCode = 1;
            return;
          }
          const report = res.data;
          if (opts.json) {
            console.log(JSON.stringify(report));
          } else {
            renderHumanReport(report);
          }
          // Exit non-zero when gaps found — operators chain into hygiene fix loops.
          if (report.gapCount > 0) process.exitCode = 1;
        });
      },
    );

  return cmd;
}

function renderHumanReport(r: ValidationReport): void {
  console.log(`workspace root: ${r.root}`);
  console.log(`workspace kind: ${r.workspaceKind ?? "(none — kind-agnostic structural check)"}`);
  console.log(`files walked:   ${r.totalFiles}`);
  console.log(`with frontmatter: ${r.filesWithFrontmatter}`);
  console.log(`gaps:           ${r.gapCount}`);
  if (r.gapCount === 0) {
    console.log("\n  no gaps — canon is clean against v0 contract.");
    return;
  }
  console.log("\n  Gaps:");
  for (const g of r.gaps) {
    const fieldStr = g.field ? ` [${g.field}]` : "";
    console.log(`    [${g.kind}] ${g.relativePath}${fieldStr}`);
    console.log(`        ${g.message}`);
  }
}
