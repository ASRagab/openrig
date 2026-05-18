// OPR.0.3.2.14 — HG-5 discriminator. Four hook-related constants
// (CLAUDE_HOOKS_ROOT + the three command-path consts) were
// independently copy-pasted across 7+ test files before this slice.
// The divergence class broke 17 tests during 0.3.1 cleanup: the
// source-side fallback subpath changed, the test-side copy didn't,
// and the hook check (pure string-compare) reported mismatch.
//
// This slice exports the constants from source and updates every
// importer to read them from there. This file pins the architectural
// fix:
//   - the source module exports each of the four constants
//   - each constant resolves under the .openrig subpath family
//     (option-B scrub away from the internal-team layout)
//   - a source-grep confirms no daemon test file re-declares the
//     constants as top-level `const` and no daemon test file
//     contains the forbidden internal-team path shape
//
// The forbidden literal is constructed at runtime from segments so
// the assertion never spells the verbatim string. The grep includes
// THIS test file too (no self-exclusion), so a future contributor
// who pastes the literal here will trip the same guard.
//
// Mutation-verified: re-introducing a test-side `const
// CLAUDE_HOOKS_ROOT = ...` declaration causes 2 tests below to FAIL.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  CLAUDE_HOOKS_ROOT,
  CLAUDE_SESSION_START_COMPACT_COMMAND,
  CLAUDE_USER_PROMPT_SUBMIT_COMMAND,
  CLAUDE_HOOK_FRAGMENT_PATH,
} from "../src/domain/restore-check-service.js";

// The forbidden shared-docs path shape (internal-team layout). Built
// from segments so the verbatim literal never appears anywhere in
// this file's source text — the source-grep guard below can therefore
// include THIS file in its scan without self-incriminating.
const FORBIDDEN_SUBPATH = ["code", "substrate", "shared-docs"].join("/");

describe("OPR.0.3.2.14 — hook constants are SINGLE-SOURCE (no test-side copy-paste)", () => {
  it("CLAUDE_HOOKS_ROOT is exported from source and resolves under the openrig subpath (not the internal-team layout)", () => {
    expect(CLAUDE_HOOKS_ROOT).toMatch(/\.openrig[/\\]shared-docs[/\\]control-plane[/\\]services[/\\]claude-hooks/);
    expect(CLAUDE_HOOKS_ROOT).not.toContain(FORBIDDEN_SUBPATH);
    expect(CLAUDE_HOOKS_ROOT).not.toContain(FORBIDDEN_SUBPATH.replace(/\//g, "\\"));
  });

  it("CLAUDE_SESSION_START_COMPACT_COMMAND is exported and lives under CLAUDE_HOOKS_ROOT/bin/", () => {
    expect(CLAUDE_SESSION_START_COMPACT_COMMAND.startsWith(CLAUDE_HOOKS_ROOT)).toBe(true);
    expect(CLAUDE_SESSION_START_COMPACT_COMMAND).toMatch(/[/\\]bin[/\\]session-start-compact-context\.sh$/);
  });

  it("CLAUDE_USER_PROMPT_SUBMIT_COMMAND is exported and lives under CLAUDE_HOOKS_ROOT/bin/", () => {
    expect(CLAUDE_USER_PROMPT_SUBMIT_COMMAND.startsWith(CLAUDE_HOOKS_ROOT)).toBe(true);
    expect(CLAUDE_USER_PROMPT_SUBMIT_COMMAND).toMatch(/[/\\]bin[/\\]userpromptsubmit-queue-attention\.sh$/);
  });

  it("CLAUDE_HOOK_FRAGMENT_PATH is exported and lives under CLAUDE_HOOKS_ROOT/config/", () => {
    expect(CLAUDE_HOOK_FRAGMENT_PATH.startsWith(CLAUDE_HOOKS_ROOT)).toBe(true);
    expect(CLAUDE_HOOK_FRAGMENT_PATH).toMatch(/[/\\]config[/\\]settings\.fragment\.json$/);
  });

  // Source-grep: no test file re-declares CLAUDE_HOOKS_ROOT as a
  // top-level const. Imports from source are fine.
  it("source-grep: no daemon test file re-declares CLAUDE_HOOKS_ROOT as a top-level const", async () => {
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const testDir = here;
    const entries = fs.readdirSync(testDir);
    const offenders: string[] = [];
    for (const name of entries) {
      if (!name.endsWith(".test.ts") && !name.endsWith(".test.tsx")) continue;
      const file = path.join(testDir, name);
      const src = fs.readFileSync(file, "utf-8");
      // Match `const CLAUDE_HOOKS_ROOT = ` (the local-redeclaration
      // pattern from pre-slice).
      if (/^const\s+CLAUDE_HOOKS_ROOT\s*=/m.test(src)) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });

  // Privacy-leak guard: no daemon test file should carry the
  // internal-team path shape anywhere. The few daemon tests that
  // needed it had it via the copy-pasted CLAUDE_HOOKS_ROOT
  // declaration; the source-side scrub + import-not-redeclare fix
  // closes both classes at once. The forbidden string is built at
  // runtime from segments so this file passes its own grep.
  it("source-grep: no daemon test file contains the forbidden shared-docs path shape", async () => {
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const testDir = here;
    const entries = fs.readdirSync(testDir);
    const offenders: Array<{ file: string; lineNo: number; line: string }> = [];
    for (const name of entries) {
      if (!name.endsWith(".test.ts") && !name.endsWith(".test.tsx")) continue;
      const file = path.join(testDir, name);
      const lines = fs.readFileSync(file, "utf-8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.includes(FORBIDDEN_SUBPATH)) {
          offenders.push({ file: name, lineNo: i + 1, line: lines[i]!.slice(0, 100) });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
