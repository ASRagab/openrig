// OPR.0.4.1.29 — LEAK-HUNT keystone: THE secret-boundary gate test.
//
// A sentinel "token" is planted in EVERY place a secret could live: the active auth file, a valid
// saved profile, a MALFORMED saved profile (the JSON.parse-error path), AND a fake `codex` shim on
// PATH that loudly emits the sentinel on both stdout and stderr. Every `rig auth` verb is then run
// through the REAL command with DEFAULT loginStatus (so the real spawnSync stdio:"ignore" path is
// exercised, not a stub), capturing BOTH console.log and console.error AND any thrown error/stack.
// The sentinel must appear in NONE of that output — stdout, stderr, or exception — for any verb.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { authCommand } from "../src/commands/auth.js";
import { resolveCodexHome, authSave, authSwitch } from "../src/lib/codex-auth.js";

// Distinctive, grep-proof: if this string ever lands in command output, the secret boundary broke.
const SENTINEL = "SENTINEL_TOKEN_LEAK_a1b2c3d4_DO_NOT_PRINT";
const NOW = () => "2026-06-26T00:00:00Z";

let home: string;
let binDir: string;
let origPath: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "codexauth-leak-"));

  // Active auth file with the sentinel token (0600).
  const active = path.join(home, "auth.json");
  fs.writeFileSync(active, JSON.stringify({ OPENAI_API_KEY: SENTINEL, tokens: { access_token: SENTINEL } }), { mode: 0o600 });
  fs.chmodSync(active, 0o600);

  // Saved-profile dir (0700) with a VALID profile and a MALFORMED profile — both carry the sentinel.
  const profileDir = path.join(home, "auth-profiles");
  fs.mkdirSync(profileDir, { mode: 0o700 });
  fs.chmodSync(profileDir, 0o700);
  const work = path.join(profileDir, "work.json");
  fs.writeFileSync(work, JSON.stringify({ OPENAI_API_KEY: SENTINEL }), { mode: 0o600 });
  fs.chmodSync(work, 0o600);
  const broken = path.join(profileDir, "broken.json");
  // Invalid JSON that still contains the sentinel — exercises the parse-error path (must not echo content).
  fs.writeFileSync(broken, `{ "OPENAI_API_KEY": "${SENTINEL}", this is not json`, { mode: 0o600 });
  fs.chmodSync(broken, 0o600);

  // Fake `codex` on PATH that emits the sentinel on stdout AND stderr, non-zero exit.
  // defaultLoginStatus spawns it with stdio:"ignore" → both streams discarded → no leak path.
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexauth-bin-"));
  const shim = path.join(binDir, "codex");
  fs.writeFileSync(shim, `#!/bin/sh\necho "${SENTINEL}"\necho "${SENTINEL}" 1>&2\nexit 3\n`, { mode: 0o755 });
  fs.chmodSync(shim, 0o755);
  origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath ?? ""}`;
});

afterEach(() => {
  process.env.PATH = origPath;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(binDir, { recursive: true, force: true });
});

// Run one `rig auth` invocation through the real command, capturing stdout + stderr + thrown errors.
async function runVerb(subArgs: string[]): Promise<string> {
  const chunks: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exitCode;
  console.log = (...a: unknown[]) => void chunks.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void chunks.push(a.map(String).join(" "));
  try {
    // DEFAULT loginStatus on purpose: only inject env so CODEX_HOME points at the fixture; the real
    // spawnSync("codex", ["login","status"], {stdio:"ignore"}) path runs against the leaky shim.
    const cmd = authCommand({ env: { CODEX_HOME: home, HOME: home, PATH: process.env.PATH }, now: NOW });
    await cmd.parseAsync(subArgs, { from: "user" });
  } catch (err) {
    // Every error/exception path is in scope: a thrown error/stack must not carry the secret either.
    chunks.push(String(err));
    if (err instanceof Error && err.stack) chunks.push(err.stack);
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exitCode = origExit; // a verb's failure sets exitCode=1; never poison the test runner
  }
  return chunks.join("\n");
}

describe("rig auth LEAK-HUNT keystone (OPR.0.4.1.29)", () => {
  it("harness can actually fail: the sentinel really is planted in files + emitted by the shim", () => {
    expect(fs.readFileSync(path.join(home, "auth.json"), "utf8")).toContain(SENTINEL);
    expect(fs.readFileSync(path.join(home, "auth-profiles", "work.json"), "utf8")).toContain(SENTINEL);
    expect(fs.readFileSync(path.join(home, "auth-profiles", "broken.json"), "utf8")).toContain(SENTINEL);
    // The shim leaks on BOTH streams when captured — proving stdio:"ignore" is what protects us.
    const probe = spawnSync("codex", ["login", "status"], { encoding: "utf8" });
    expect(`${probe.stdout}${probe.stderr}`).toContain(SENTINEL);
  });

  it("no sentinel in ANY verb's stdout, stderr, or error path", async () => {
    // Order matters: save/switch mutate auth state; seats set must precede list/show/report.
    const verbs: string[][] = [
      ["status"], // runs the real codex shim via default loginStatus (stdio:"ignore")
      ["list"],
      ["save", "snapshot"], // copies the sentinel-bearing active auth into a new profile
      ["switch", "work"], // copies the sentinel-bearing profile onto active auth
      ["validate", "work"], // valid JSON path
      ["validate", "broken"], // MALFORMED → must report a fixed reason, never the file content
      ["validate", "missing-one"], // missing → fixed reason
      ["seats", "set", "--seat", "dev1@rig", "--rig", "rig", "--cwd", "/x", "--profile", "work"],
      ["seats", "list"],
      ["seats", "show", "dev1@rig"],
      ["seats", "report"],
    ];
    let all = "";
    for (const v of verbs) {
      const out = await runVerb(v);
      all += `\n## rig auth ${v.join(" ")}\n${out}`;
    }
    expect(all).not.toContain(SENTINEL);
    // Sanity: we actually captured real output (not silently empty), so the assertion is meaningful.
    expect(all).toContain("codex_home:");
    expect(all).toContain("saved_profile:");
    expect(all).toContain("malformed_json");
  });
});

// rev1-r2 adversarial finding: the file-level symlink guard missed HARDLINKS (a regular non-symlink
// file whose inode lives outside CODEX_HOME) and SYMLINKED PARENT DIRS (an auth-profiles symlink). Both
// let save/switch write secret bytes outside the boundary. Each case must refuse with unsafe_path AND
// leave zero secret bytes outside CODEX_HOME.
describe("rig auth LEAK-HUNT — hardlink + symlinked-parent escapes (rev1-r2)", () => {
  function fixture() {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), "codexauth-esc-"));
    const p = resolveCodexHome({ CODEX_HOME: h });
    fs.writeFileSync(p.activeAuth, JSON.stringify({ OPENAI_API_KEY: SENTINEL }), { mode: 0o600 });
    fs.chmodSync(p.activeAuth, 0o600);
    fs.mkdirSync(p.profileDir, { recursive: true });
    fs.chmodSync(p.profileDir, 0o700);
    return { h, p };
  }

  it("authSave refuses a HARDLINK to an inode OUTSIDE CODEX_HOME; the outside inode keeps no secret", () => {
    const { h, p } = fixture();
    // The hardlink target must live in a root that is genuinely NOT under CODEX_HOME, so this proves
    // the real outside-CODEX_HOME boundary (same filesystem under os.tmpdir() so linkSync can succeed).
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codexauth-outroot-"));
    expect(outsideRoot.startsWith(h + path.sep)).toBe(false);
    const outside = path.join(outsideRoot, "outside-hardlink.json");
    fs.writeFileSync(outside, "ORIGINAL", { mode: 0o600 });
    fs.linkSync(outside, path.join(p.profileDir, "work.json")); // hardlink an OUTSIDE inode in (nlink=2)
    expect(authSave(p, "work")).toEqual({ ok: false, reason: "unsafe_path" });
    expect(fs.readFileSync(outside, "utf8")).toBe("ORIGINAL");
    expect(fs.readFileSync(outside, "utf8")).not.toContain(SENTINEL);
    fs.rmSync(h, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  });

  it("authSwitch refuses a HARDLINKED active auth pointing OUTSIDE CODEX_HOME; the outside inode keeps no secret", () => {
    const { h, p } = fixture();
    authSave(p, "work"); // a real saved profile carrying the secret
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codexauth-outroot-"));
    expect(outsideRoot.startsWith(h + path.sep)).toBe(false);
    const outside = path.join(outsideRoot, "outside-active-hardlink.json");
    fs.writeFileSync(outside, "ORIGINAL", { mode: 0o600 });
    fs.rmSync(p.activeAuth);
    fs.linkSync(outside, p.activeAuth); // active auth is a hardlink to an OUTSIDE inode (nlink=2)
    expect(authSwitch(p, "work")).toEqual({ ok: false, reason: "unsafe_path" });
    expect(fs.readFileSync(outside, "utf8")).toBe("ORIGINAL");
    expect(fs.readFileSync(outside, "utf8")).not.toContain(SENTINEL);
    fs.rmSync(h, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  });

  it("authSave refuses a SYMLINKED auth-profiles parent; no secret written outside CODEX_HOME", () => {
    const { h, p } = fixture();
    fs.rmSync(p.profileDir, { recursive: true, force: true });
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexauth-outdir-"));
    expect(outsideDir.startsWith(h + path.sep)).toBe(false); // genuinely outside CODEX_HOME
    fs.symlinkSync(outsideDir, p.profileDir); // auth-profiles -> /outside/dir
    expect(authSave(p, "work")).toEqual({ ok: false, reason: "unsafe_path" });
    const leaked = fs.readdirSync(outsideDir).some((f) => {
      try {
        return fs.readFileSync(path.join(outsideDir, f), "utf8").includes(SENTINEL);
      } catch {
        return false;
      }
    });
    expect(leaked).toBe(false);
    fs.rmSync(h, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });
});
