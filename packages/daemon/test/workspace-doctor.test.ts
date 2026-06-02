// Slice-21 FR-5 — workspace doctor check unit tests.
//
// Per banked feedback_handoff_body_claims_need_discriminator_verification,
// each check ships with a discriminator-flip negative test: if the
// production code were wrong, the assertion would catch it.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  checkWorkspaceRootReachable,
  type DoctorCheck,
} from "../src/domain/workspace/workspace-doctor.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr5-doctor-"));
});

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("FR-5 check #1 — workspace root reachable", () => {
  it("returns ok when workspace root is an existing directory", () => {
    const result: DoctorCheck = checkWorkspaceRootReachable({ workspaceRoot: dir, source: "default" });
    expect(result.check).toBe("workspace_root_reachable");
    expect(result.status).toBe("ok");
    expect(result.message).toContain(dir);
    expect(result.fixHint).toBeUndefined();
    expect(result.evidence).toEqual({ workspaceRoot: dir, source: "default" });
  });

  // Discriminator-flip: ENOENT path MUST be a fail, not silently pass.
  it("returns fail with ENOENT evidence when workspace root does not exist", () => {
    const missing = path.join(dir, "definitely-not-here");
    const result = checkWorkspaceRootReachable({ workspaceRoot: missing, source: "env" });
    expect(result.status).toBe("fail");
    expect(result.message).toContain("does not exist");
    expect(result.message).toContain("env");
    expect(result.fixHint).toContain("OPENRIG_WORKSPACE_ROOT");
    expect(result.evidence?.errorCode).toBe("ENOENT");
  });

  // Discriminator-flip: a file (not directory) at the root MUST fail, not pass.
  // Without isDirectory() check, statSync would succeed and the check
  // would return ok — this test catches that regression.
  it("returns fail when workspace root is a regular file, not a directory", () => {
    const filePath = path.join(dir, "not-a-dir");
    fs.writeFileSync(filePath, "");
    const result = checkWorkspaceRootReachable({ workspaceRoot: filePath, source: "file" });
    expect(result.status).toBe("fail");
    expect(result.message).toContain("not a directory");
    expect(result.fixHint).toContain("config.json");
    expect(result.evidence?.kind).toBe("not_a_directory");
  });

  // Source-aware fix-hint discriminator. If fix-hint resolution were
  // hard-coded to one source, this would catch it.
  it("emits source-aware fix-hints (env vs file vs default)", () => {
    const missing = path.join(dir, "missing");
    const envResult = checkWorkspaceRootReachable({ workspaceRoot: missing, source: "env" });
    const fileResult = checkWorkspaceRootReachable({ workspaceRoot: missing, source: "file" });
    const defaultResult = checkWorkspaceRootReachable({ workspaceRoot: missing, source: "default" });
    expect(envResult.fixHint).toContain("OPENRIG_WORKSPACE_ROOT");
    expect(envResult.fixHint).not.toContain("workspace.root in config.json");
    expect(fileResult.fixHint).toContain("workspace.root in config.json");
    expect(fileResult.fixHint).not.toContain("OPENRIG_WORKSPACE_ROOT");
    expect(defaultResult.fixHint).toContain("rig config init-workspace");
  });

  // Discriminator-flip: non-ENOENT IO error must still fail with a
  // useful message + evidence.errorCode (e.g., EACCES on permission
  // denied). Simulate by chmod 000 on a created subdir.
  it("returns fail with errorCode evidence on non-ENOENT stat error", () => {
    // Skip on platforms where chmod doesn't restrict stat (e.g. Windows,
    // root user). The check is the discriminator-flip we want, but it
    // must be robust under varied test environments.
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const lockedParent = path.join(dir, "locked-parent");
    fs.mkdirSync(lockedParent);
    const inside = path.join(lockedParent, "inside");
    fs.mkdirSync(inside);
    try {
      fs.chmodSync(lockedParent, 0o000);
      const result = checkWorkspaceRootReachable({ workspaceRoot: inside, source: "env" });
      expect(result.status).toBe("fail");
      expect(result.evidence?.errorCode).toBeDefined();
      expect(result.evidence?.errorCode).not.toBe("unknown");
    } finally {
      fs.chmodSync(lockedParent, 0o700);
    }
  });
});
