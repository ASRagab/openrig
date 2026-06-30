// OPR.0.4.1.21 — Artifacts altitude-scoped file navigator. Read-only projection
// over the existing /api/files/* endpoints. TDD against the 7 ACs; the load-bearing
// one is AC-3 (the lazy-load boundary — no eager file-body fetch, no tree pre-walk).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ArtifactsNavigator } from "../src/components/project/ArtifactsNavigator.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

let calls: string[] = [];

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

// Fixture tree under allowlist root "work" (path "/ws"). The mission altitude
// base is missions/release-0.4.1; one slice subtree is included for AC-4.
const TREE: Record<string, Array<{ name: string; type: "dir" | "file" | "other"; size: number | null; mtime: string | null }>> = {
  "missions/release-0.4.1": [
    { name: "README.md", type: "file", size: 4096, mtime: "2026-06-23T22:01:00.000Z" },
    { name: "PROGRESS.md", type: "file", size: 3170, mtime: "2026-06-23T05:00:00.000Z" },
    { name: "slices", type: "dir", size: null, mtime: "2026-06-23T22:52:00.000Z" },
    { name: "digital-twin", type: "dir", size: null, mtime: "2026-06-23T22:52:00.000Z" },
  ],
  "missions/release-0.4.1/slices": [
    { name: "09-seat-restore", type: "dir", size: null, mtime: "2026-06-22T10:00:00.000Z" },
    { name: "15-workspace-ux", type: "dir", size: null, mtime: "2026-06-23T22:52:00.000Z" },
  ],
  "missions/release-0.4.1/slices/15-workspace-ux": [
    { name: "README.md", type: "file", size: 4096, mtime: "2026-06-23T22:01:00.000Z" },
    { name: "batch-1.change.diff", type: "file", size: 12288, mtime: "2026-06-23T22:52:00.000Z" },
    { name: "03-story-dag.intent.png", type: "file", size: 129024, mtime: "2026-06-23T22:53:00.000Z" },
  ],
};

function routeFiles({ rootsStatus = 200, rootsEmpty = false }: { rootsStatus?: number; rootsEmpty?: boolean } = {}) {
  return (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/api/files/roots")) {
      if (rootsStatus === 503) {
        return Promise.resolve(jsonResponse({ error: "files_routes_unavailable", hint: "Configure a workspace files root" }, 503));
      }
      if (rootsEmpty) {
        // files.ts returns 200 with an empty list + hint when no allowlist is set.
        return Promise.resolve(jsonResponse({ roots: [], hint: "No allowlist roots configured. Set OPENRIG_FILES_ALLOWLIST=..." }, 200));
      }
      return Promise.resolve(jsonResponse({ roots: [{ name: "work", path: "/ws" }] }));
    }
    if (url.includes("/api/files/list")) {
      const u = new URL(url, "http://twin.local");
      const path = u.searchParams.get("path") ?? "";
      return Promise.resolve(jsonResponse({ root: "work", path, entries: TREE[path] ?? [] }));
    }
    return Promise.resolve(jsonResponse({}, 404));
  };
}

function listedPaths(): string[] {
  return calls
    .filter((c) => c.includes("/api/files/list"))
    .map((c) => new URL(c, "http://twin.local").searchParams.get("path") ?? "");
}

function renderNav(scopePath: string | null = "/ws/missions/release-0.4.1", scopeLabel = "release-0.4.1") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ArtifactsNavigator scopePath={scopePath} scopeLabel={scopeLabel} />
    </QueryClientProvider>,
  );
}

describe("OPR.0.4.1.21 — Artifacts navigator", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    calls = [];
  });
  afterEach(() => cleanup());

  it("AC-1: renders the folder tree (left) + the selected folder's file list (right)", async () => {
    mockFetch.mockImplementation(routeFiles());
    renderNav();
    await waitFor(() => expect(screen.getByTestId("artifacts-navigator")).toBeTruthy());
    expect(screen.getByTestId("artifacts-tree")).toBeTruthy();
    expect(screen.getByTestId("artifacts-file-list")).toBeTruthy();
    // Right pane lists the base folder's FILES (not its dirs); wait for the
    // base /list to resolve before asserting the lazily-rendered tree children.
    await waitFor(() => expect(screen.getByTestId("artifacts-file-row-README.md")).toBeTruthy());
    expect(screen.getByTestId("artifacts-file-row-PROGRESS.md")).toBeTruthy();
    // Tree root expands to show the base folder's subfolders.
    expect(screen.getByTestId("artifacts-tree-folder-missions/release-0.4.1/slices")).toBeTruthy();
  });

  it("AC-2: each file row shows a type badge (from extension), size, and mtime", async () => {
    mockFetch.mockImplementation(routeFiles());
    renderNav();
    await waitFor(() => expect(screen.getByTestId("artifacts-file-row-README.md")).toBeTruthy());
    expect(screen.getByTestId("artifacts-file-badge-README.md").textContent).toBe("MD");
    expect(screen.getByTestId("artifacts-file-size-README.md").textContent).toBe("4.0 KB");
    // mtime sourced from the /list entry (formatted), not fabricated.
    expect(screen.getByTestId("artifacts-file-mtime-README.md").textContent).toMatch(/06-23/);
  });

  it("AC-3: lazy-load boundary — landing fetches only /roots + /list(base); NO file bodies, NO tree pre-walk", async () => {
    mockFetch.mockImplementation(routeFiles());
    renderNav();
    await waitFor(() => expect(screen.getByTestId("artifacts-file-row-README.md")).toBeTruthy());

    // /roots + /list(base) only.
    expect(calls.some((c) => c.includes("/api/files/roots"))).toBe(true);
    expect(listedPaths()).toContain("missions/release-0.4.1");
    // NO file body fetched on landing (the slice-17 over-fetch lesson).
    expect(calls.some((c) => c.includes("/api/files/read"))).toBe(false);
    expect(calls.some((c) => c.includes("/api/files/asset"))).toBe(false);
    // NOT pre-walked: collapsed subfolders are not listed until expanded.
    expect(listedPaths()).not.toContain("missions/release-0.4.1/slices");
  });

  it("AC-3 (expand is lazy): expanding a folder fetches /list for THAT folder only", async () => {
    mockFetch.mockImplementation(routeFiles());
    renderNav();
    await waitFor(() => expect(screen.getByTestId("artifacts-tree-toggle-missions/release-0.4.1/slices")).toBeTruthy());
    expect(listedPaths()).not.toContain("missions/release-0.4.1/slices");

    fireEvent.click(screen.getByTestId("artifacts-tree-toggle-missions/release-0.4.1/slices"));
    await waitFor(() => expect(listedPaths()).toContain("missions/release-0.4.1/slices"));
    // Still no file bodies, and the grandchild slice is not pre-walked.
    expect(calls.some((c) => c.includes("/api/files/read"))).toBe(false);
    expect(listedPaths()).not.toContain("missions/release-0.4.1/slices/15-workspace-ux");
  });

  it("AC-4: altitude scoping — a slice scopePath roots the tree at the slice dir, no sibling slices", async () => {
    mockFetch.mockImplementation(routeFiles());
    renderNav("/ws/missions/release-0.4.1/slices/15-workspace-ux", "15-workspace-ux");
    await waitFor(() => expect(screen.getByTestId("artifacts-file-row-batch-1.change.diff")).toBeTruthy());
    // Right pane lists the slice's files.
    expect(screen.getByTestId("artifacts-file-badge-batch-1.change.diff").textContent).toBe("DIFF");
    expect(screen.getByTestId("artifacts-file-badge-03-story-dag.intent.png").textContent).toBe("PNG");
    // The tree is rooted at the slice; the base listed is the slice dir, and the
    // sibling slice (09-seat-restore) is never surfaced.
    expect(listedPaths()).toContain("missions/release-0.4.1/slices/15-workspace-ux");
    expect(listedPaths()).not.toContain("missions/release-0.4.1/slices");
    expect(screen.queryByTestId("artifacts-tree-folder-missions/release-0.4.1/slices/09-seat-restore")).toBeNull();
  });

  it("AC-5: no allowlist root configured (503) renders a self-explanatory setup hint", async () => {
    mockFetch.mockImplementation(routeFiles({ rootsStatus: 503 }));
    renderNav();
    await waitFor(() => expect(screen.getByTestId("artifacts-navigator-unavailable")).toBeTruthy());
    expect(screen.getByTestId("artifacts-navigator-unavailable").textContent).toMatch(/files root/i);
    // Read-only: never wrote.
    expect(calls.some((c) => c.includes("/api/files/write"))).toBe(false);
  });

  // rev1-r2 regression: the no-allowlist case is NOT a 503 — files.ts returns a
  // 200 with { roots: [], hint }. That must show the SAME setup hint (preferring
  // the daemon's hint), not the misleading "out of scope / no artifacts" state.
  it("AC-5 (empty roots): a 200 roots:[] + hint (no allowlist) renders the setup hint, not 'no artifacts'", async () => {
    mockFetch.mockImplementation(routeFiles({ rootsEmpty: true }));
    renderNav();
    await waitFor(() => expect(screen.getByTestId("artifacts-navigator-unavailable")).toBeTruthy());
    // The daemon's own hint is surfaced (the actionable setup instruction).
    expect(screen.getByTestId("artifacts-navigator-unavailable").textContent).toMatch(/OPENRIG_FILES_ALLOWLIST/);
    // NOT the misleading out-of-scope state.
    expect(screen.queryByTestId("artifacts-navigator-no-scope")).toBeNull();
  });
});
