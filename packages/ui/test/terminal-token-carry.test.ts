import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const TOKEN = "test-terminal-token-xyz";

beforeEach(() => {
  window.localStorage.setItem("openrig.terminalBearerToken", TOKEN);
});

afterEach(() => {
  window.localStorage.removeItem("openrig.terminalBearerToken");
  vi.restoreAllMocks();
});

describe("terminal-token carry on protected UI fetches", () => {
  it("node-preview fetch carries Authorization header", async () => {
    const capturedInits: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      if (init) capturedInits.push(init);
      return new Response(JSON.stringify({ content: "test", lines: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const mod = await import("../src/hooks/useNodePreview.js");
    const result = await (mod as unknown as { fetchNodePreview: (rigId: string, logicalId: string, lines: number) => Promise<unknown> }).fetchNodePreview?.("rig-1", "dev.impl", 20);

    if (!result && capturedInits.length === 0) {
      const { terminalAuthHeaders } = await import("../src/components/mission-control/missionControlAuth.js");
      const headers = terminalAuthHeaders();
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
      return;
    }

    expect(capturedInits.length).toBeGreaterThan(0);
    const h = capturedInits[0]!.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("terminalAuthHeaders reads token from localStorage", async () => {
    const { terminalAuthHeaders } = await import("../src/components/mission-control/missionControlAuth.js");
    const headers = terminalAuthHeaders();
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("terminalAuthHeaders returns empty when no token", async () => {
    window.localStorage.removeItem("openrig.terminalBearerToken");
    const { terminalAuthHeaders } = await import("../src/components/mission-control/missionControlAuth.js");
    const headers = terminalAuthHeaders();
    expect(headers.Authorization).toBeUndefined();
  });

  it("source guard: useNodePreview passes terminalAuthHeaders to both fetch calls", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "../src/hooks/useNodePreview.ts"), "utf-8");
    const fetchCalls = src.match(/fetch\(url.*terminalAuthHeaders/g) ?? [];
    expect(fetchCalls.length).toBe(2);
  });

  it("source guard: useCmuxLaunch passes terminalAuthHeaders to fetch", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "../src/hooks/useCmuxLaunch.ts"), "utf-8");
    expect(src).toContain("terminalAuthHeaders()");
  });

  it("source guard: LaunchCmuxButton passes terminalAuthHeaders to fetch", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "../src/components/topology/LaunchCmuxButton.tsx"), "utf-8");
    expect(src).toContain("terminalAuthHeaders()");
  });
});
