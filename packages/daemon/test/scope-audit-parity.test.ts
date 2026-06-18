import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

const CLASSIFIER_FILES = [
  { cli: "packages/cli/src/lib/scope/scope-audit.ts", daemon: "packages/daemon/src/domain/scope/scope-audit.ts" },
  { cli: "packages/cli/src/lib/scope/dot-id.ts", daemon: "packages/daemon/src/domain/scope/dot-id.ts" },
  { cli: "packages/cli/src/lib/scope/types.ts", daemon: "packages/daemon/src/domain/scope/types.ts" },
];

describe("scope-audit CLI/daemon parity (CI-FAILING)", () => {
  for (const pair of CLASSIFIER_FILES) {
    it(`${path.basename(pair.cli)} is byte-equivalent across CLI and daemon`, () => {
      const cliContent = fs.readFileSync(path.join(REPO_ROOT, pair.cli), "utf-8");
      const daemonContent = fs.readFileSync(path.join(REPO_ROOT, pair.daemon), "utf-8");
      expect(daemonContent).toBe(cliContent);
    });
  }
});
