import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  classifyScopeItem as daemonClassifier,
  type ScopeAuditInput,
} from "../src/domain/scope/scope-audit.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

const CLASSIFIER_FILES = [
  { cli: "packages/cli/src/lib/scope/scope-audit.ts", daemon: "packages/daemon/src/domain/scope/scope-audit.ts" },
  { cli: "packages/cli/src/lib/scope/dot-id.ts", daemon: "packages/daemon/src/domain/scope/dot-id.ts" },
  { cli: "packages/cli/src/lib/scope/types.ts", daemon: "packages/daemon/src/domain/scope/types.ts" },
];

const SHARED_FIXTURES: Array<{ label: string; input: ScopeAuditInput }> = [
  {
    label: "present: valid id + PROGRESS.md",
    input: { id: null, path: "/fix/mission", readmeFrontmatterRaw: "id: OPR.0.4.0", progressFileExists: true, readmeOnlyMarker: false, isActiveRelease: true, level: "mission" },
  },
  {
    label: "missing: no PROGRESS.md, no marker",
    input: { id: null, path: "/fix/mission", readmeFrontmatterRaw: "id: OPR.0.4.0", progressFileExists: false, readmeOnlyMarker: false, isActiveRelease: true, level: "mission" },
  },
  {
    label: "malformed: YAML parse error + id line (ghost)",
    input: { id: null, path: "/fix/slice", readmeFrontmatterRaw: "id: OPR.0.4.0.1\nbad: {{yaml", progressFileExists: true, readmeOnlyMarker: false, isActiveRelease: true, level: "slice" },
  },
  {
    label: "malformed: YAML parse error without id line",
    input: { id: null, path: "/fix/slice", readmeFrontmatterRaw: "broken: {{yaml", progressFileExists: false, readmeOnlyMarker: false, isActiveRelease: true, level: "slice" },
  },
  {
    label: "readme-only: marker set, no PROGRESS.md",
    input: { id: null, path: "/fix/slice", readmeFrontmatterRaw: "id: OPR.0.4.0.2\nprogress_rail: readme-only", progressFileExists: false, readmeOnlyMarker: true, isActiveRelease: true, level: "slice" },
  },
  {
    label: "missing-id: frontmatter parses but no id",
    input: { id: null, path: "/fix/slice", readmeFrontmatterRaw: "title: Some slice\nstatus: active", progressFileExists: true, readmeOnlyMarker: false, isActiveRelease: true, level: "slice" },
  },
  {
    label: "id-convention-violation: bad mission id",
    input: { id: null, path: "/fix/mission", readmeFrontmatterRaw: "id: not-a-dot-id", progressFileExists: true, readmeOnlyMarker: false, isActiveRelease: true, level: "mission" },
  },
  {
    label: "id-convention-violation: bad slice id",
    input: { id: null, path: "/fix/slice", readmeFrontmatterRaw: "id: not-valid", progressFileExists: true, readmeOnlyMarker: false, isActiveRelease: false, level: "slice" },
  },
  {
    label: "no frontmatter (null): emits missing_id",
    input: { id: null, path: "/fix/mission", readmeFrontmatterRaw: null, progressFileExists: true, readmeOnlyMarker: false, isActiveRelease: true, level: "mission" },
  },
  {
    label: "historical severity: missing progress LOW",
    input: { id: null, path: "/fix/mission", readmeFrontmatterRaw: "id: OPR.0.3.4", progressFileExists: false, readmeOnlyMarker: false, isActiveRelease: false, level: "mission" },
  },
];

describe("scope-audit CLI/daemon parity (CI-FAILING)", () => {
  describe("byte-equivalence", () => {
    for (const pair of CLASSIFIER_FILES) {
      it(`${path.basename(pair.cli)} is byte-equivalent across CLI and daemon`, () => {
        const cliContent = fs.readFileSync(path.join(REPO_ROOT, pair.cli), "utf-8");
        const daemonContent = fs.readFileSync(path.join(REPO_ROOT, pair.daemon), "utf-8");
        expect(daemonContent).toBe(cliContent);
      });
    }
  });

  describe("shared-fixture output parity", () => {
    let cliClassifier: typeof daemonClassifier;

    it("loads CLI classifier", async () => {
      const mod = await import(
        path.join(REPO_ROOT, "packages/cli/src/lib/scope/scope-audit.ts")
      );
      cliClassifier = mod.classifyScopeItem;
      expect(typeof cliClassifier).toBe("function");
    });

    for (const fixture of SHARED_FIXTURES) {
      it(`fixture: ${fixture.label}`, () => {
        if (!cliClassifier) throw new Error("CLI classifier not loaded");
        const cliResult = cliClassifier(fixture.input);
        const daemonResult = daemonClassifier(fixture.input);
        expect(daemonResult).toEqual(cliResult);
      });
    }
  });
});
