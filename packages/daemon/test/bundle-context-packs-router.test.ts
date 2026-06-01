import { describe, it, expect } from "vitest";
import { routeContextPacks, type ContextPacksRouterFsOps, type RouteContextPacksInput } from "../src/domain/bundle-context-packs-router.js";

// Item 6 / slice-05 Checkpoint 7.3f step 2: bundle-context-packs-router
// pure-function tests. Mirrors plugins router (dir-based) with the
// context-pack-specific degenerate-input handling per the consumer
// contract (context-pack-library-service.scan walks pack dirs whose
// immediate child is manifest.yaml).

function mockFs(initial: { dirs?: string[] } = {}): ContextPacksRouterFsOps & {
  _copyCalls: Array<{ src: string; dest: string }>;
  _mkdirpCalls: string[];
  _dirs: Set<string>;
} {
  const dirs = new Set<string>(initial.dirs ?? []);
  const copyCalls: Array<{ src: string; dest: string }> = [];
  const mkdirpCalls: string[] = [];
  return {
    _copyCalls: copyCalls,
    _mkdirpCalls: mkdirpCalls,
    _dirs: dirs,
    exists: (p: string) => dirs.has(p),
    isDirectory: (p: string) => dirs.has(p),
    mkdirp: (p: string) => { mkdirpCalls.push(p); dirs.add(p); },
    copyDir: (src: string, dest: string) => { copyCalls.push({ src, dest }); dirs.add(dest); },
  };
}

const BUNDLE_ROOT = "/bundle/root";
const TARGET = "/operator/.openrig/context-packs";

function makeInput(overrides?: Partial<RouteContextPacksInput>): RouteContextPacksInput {
  return {
    bundleRoot: BUNDLE_ROOT,
    declaredContextPacks: [],
    targetContextPacksDir: TARGET,
    ...overrides,
  };
}

describe("routeContextPacks", () => {
  // C1: empty list → empty records + target dir mkdirp'd
  it("empty declaredContextPacks produces empty records but still mkdirp's target", () => {
    const fs = mockFs();
    const result = routeContextPacks(makeInput(), fs);
    expect(result.records).toEqual([]);
    expect(result.routedCount).toBe(0);
    expect(result.rejectedCount).toBe(0);
    expect(fs._mkdirpCalls).toContain(TARGET);
  });

  // C2: routes one pack: copyDir from sourceParentDir to target/<dirname>
  it("routes one context_pack: parent dir copied to target/<dirname>", () => {
    const fs = mockFs({ dirs: [`${BUNDLE_ROOT}/context-packs/intent`] });
    const result = routeContextPacks(
      makeInput({ declaredContextPacks: ["context-packs/intent/manifest.yaml"] }),
      fs,
    );
    expect(result.routedCount).toBe(1);
    expect(result.records[0]!.status).toBe("routed");
    expect(result.records[0]!.installedAt).toBe(`${TARGET}/intent`);
    expect(fs._copyCalls).toHaveLength(1);
    expect(fs._copyCalls[0]).toEqual({
      src: `${BUNDLE_ROOT}/context-packs/intent`,
      dest: `${TARGET}/intent`,
    });
  });

  // C3: multiple distinct packs route correctly
  it("routes multiple distinct context_packs each to target/<dirname>", () => {
    const fs = mockFs({
      dirs: [`${BUNDLE_ROOT}/context-packs/intent`, `${BUNDLE_ROOT}/context-packs/persona`],
    });
    const result = routeContextPacks(
      makeInput({
        declaredContextPacks: [
          "context-packs/intent/manifest.yaml",
          "context-packs/persona/manifest.yaml",
        ],
      }),
      fs,
    );
    expect(result.routedCount).toBe(2);
    expect(fs._copyCalls).toHaveLength(2);
  });

  // C4: missing source pack dir skipped honestly
  it("missing source pack dir → status=missing (honest-scoping)", () => {
    const fs = mockFs();
    const result = routeContextPacks(
      makeInput({ declaredContextPacks: ["context-packs/absent/manifest.yaml"] }),
      fs,
    );
    expect(result.routedCount).toBe(0);
    expect(result.records[0]!.status).toBe("missing");
    expect(result.records[0]!.detail).toContain("not present");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // C5: unsafe source path escaping bundle workspace rejected
  it("unsafe source path escaping bundle workspace → status=unsafe", () => {
    const fs = mockFs();
    const result = routeContextPacks(
      makeInput({ declaredContextPacks: ["../escape/manifest.yaml"] }),
      fs,
    );
    expect(result.records[0]!.status).toBe("unsafe");
    expect(result.records[0]!.detail).toContain("escapes bundle workspace");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // C6 (degenerate-input): basename not manifest.yaml — consumer-invisible
  // class. Per banked PRE-handoff degenerate-input dogfood discipline.
  it("declared path with non-manifest.yaml basename → status=not_manifest", () => {
    const fs = mockFs({ dirs: [`${BUNDLE_ROOT}/context-packs/oddpack`] });
    const result = routeContextPacks(
      makeInput({
        declaredContextPacks: [
          "context-packs/oddpack/pack.yaml",
          "context-packs/oddpack/manifest.txt",
        ],
      }),
      fs,
    );
    expect(result.records).toHaveLength(2);
    expect(result.routedCount).toBe(0);
    expect(result.records[0]!.status).toBe("not_manifest");
    expect(result.records[0]!.detail).toContain("manifest.yaml");
    expect(result.records[1]!.status).toBe("not_manifest");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // C7 (degenerate-input): parent-dir basename collision — first wins,
  // second flagged conflict. Banked workflow_specs B1 lesson applied.
  it("two declared packs sharing parent-dir basename → first routed, second conflict", () => {
    const fs = mockFs({
      dirs: [
        `${BUNDLE_ROOT}/a/intent`,
        `${BUNDLE_ROOT}/b/intent`,
      ],
    });
    const result = routeContextPacks(
      makeInput({
        declaredContextPacks: [
          "a/intent/manifest.yaml",
          "b/intent/manifest.yaml",
        ],
      }),
      fs,
    );
    expect(result.records).toHaveLength(2);
    expect(result.routedCount).toBe(1);
    expect(result.rejectedCount).toBe(1);
    expect(result.records[0]!.status).toBe("routed");
    expect(result.records[0]!.installedAt).toBe(`${TARGET}/intent`);
    expect(result.records[1]!.status).toBe("conflict");
    expect(result.records[1]!.detail).toContain("intent");
    expect(result.records[1]!.detail).toContain("collides");
    // Only the first copyDir fires.
    expect(fs._copyCalls).toHaveLength(1);
    expect(fs._copyCalls[0]!.src).toBe(`${BUNDLE_ROOT}/a/intent`);
  });

  // C8: pack source path exists but is a file not a directory — edge case
  // (unusual; manifest.yaml dirname resolved to a file). Skipped honestly.
  it("source parent exists but is a file (not directory) → status=not_directory", () => {
    // mockFs treats anything in dirs[] as a dir; for this case construct
    // an exists-but-not-isDirectory state by overriding isDirectory.
    const fs = mockFs();
    fs._dirs.add(`${BUNDLE_ROOT}/oddpath`); // exists
    // Override isDirectory just for this path:
    const origIsDir = fs.isDirectory;
    fs.isDirectory = (p: string) => p === `${BUNDLE_ROOT}/oddpath` ? false : origIsDir(p);
    const result = routeContextPacks(
      makeInput({ declaredContextPacks: ["oddpath/manifest.yaml"] }),
      fs,
    );
    expect(result.records[0]!.status).toBe("not_directory");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // C9: mixed list — routed + missing + unsafe + not_manifest + conflict
  // aggregate correctly
  it("mixed declared list aggregates correctly across all rejection classes", () => {
    const fs = mockFs({
      dirs: [
        `${BUNDLE_ROOT}/context-packs/ok`,
        `${BUNDLE_ROOT}/context-packs/dup`,
        `${BUNDLE_ROOT}/elsewhere/dup`,
      ],
    });
    const result = routeContextPacks(
      makeInput({
        declaredContextPacks: [
          "context-packs/ok/manifest.yaml",         // routed
          "context-packs/absent/manifest.yaml",      // missing
          "../escape/manifest.yaml",                  // unsafe
          "context-packs/odd/pack.yaml",              // not_manifest
          "context-packs/dup/manifest.yaml",         // routed (1st dup)
          "elsewhere/dup/manifest.yaml",             // conflict (basename dup with above)
        ],
      }),
      fs,
    );
    expect(result.records).toHaveLength(6);
    expect(result.routedCount).toBe(2);
    expect(result.rejectedCount).toBe(4);
    expect(result.records[0]!.status).toBe("routed");
    expect(result.records[1]!.status).toBe("missing");
    expect(result.records[2]!.status).toBe("unsafe");
    expect(result.records[3]!.status).toBe("not_manifest");
    expect(result.records[4]!.status).toBe("routed");
    expect(result.records[5]!.status).toBe("conflict");
  });
});
