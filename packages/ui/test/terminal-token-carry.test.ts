import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const TOKEN = "test-terminal-token-xyz";

beforeEach(() => {
  window.localStorage.setItem("openrig.terminalBearerToken", TOKEN);
});

afterEach(() => {
  window.localStorage.removeItem("openrig.terminalBearerToken");
  vi.restoreAllMocks();
});

function stubFetch(): { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ content: "test", lines: 1, ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { calls };
}

describe("terminal-token carry on protected UI fetches", () => {
  it("fetchNodePreview sends Authorization: Bearer <token>", async () => {
    const { calls } = stubFetch();
    const { fetchNodePreview } = await import("../src/hooks/useNodePreview.js");
    await fetchNodePreview("rig-1", "dev.impl", 20);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toContain("/preview");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("fetchSessionPreview sends Authorization: Bearer <token>", async () => {
    const { calls } = stubFetch();
    const { fetchSessionPreview } = await import("../src/hooks/useNodePreview.js");
    await fetchSessionPreview("dev-impl@test-rig", 20);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toContain("/preview");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("terminalAuthHeaders reads token from localStorage", async () => {
    const { terminalAuthHeaders } = await import("../src/components/mission-control/missionControlAuth.js");
    expect(terminalAuthHeaders().Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("terminalAuthHeaders returns empty when no token", async () => {
    window.localStorage.removeItem("openrig.terminalBearerToken");
    const { terminalAuthHeaders } = await import("../src/components/mission-control/missionControlAuth.js");
    expect(terminalAuthHeaders().Authorization).toBeUndefined();
  });

  it("postOpenCmux sends Authorization: Bearer <token>", async () => {
    const { calls } = stubFetch();
    const { postOpenCmux } = await import("../src/hooks/useCmuxLaunch.js");
    await postOpenCmux({ rigId: "rig-1", logicalId: "dev.impl" });
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toContain("/open-cmux");
    expect(calls[0]!.init?.method).toBe("POST");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("source guard: all /open-cmux fetches carry terminalAuthHeaders", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const srcDir = path.resolve(import.meta.dirname, "../src");
    const files = [
      "hooks/useCmuxLaunch.ts",
      "components/topology/LaunchCmuxButton.tsx",
      "components/LiveNodeDetails.tsx",
      "components/RigNode.tsx",
    ];
    for (const file of files) {
      const src = fs.readFileSync(path.join(srcDir, file), "utf-8");
      const cmuxFetches = [...src.matchAll(/fetch\([^)]*open-cmux[^)]*\)/gs)];
      for (const match of cmuxFetches) {
        expect(match[0]).toContain("terminalAuthHeaders()");
      }
    }
  });

  it("source guard: useCmuxLaunch wires terminalAuthHeaders", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "../src/hooks/useCmuxLaunch.ts"), "utf-8");
    expect(src).toContain("terminalAuthHeaders()");
    expect(src).toContain("headers: terminalAuthHeaders()");
  });

  it("source guard: LaunchCmuxButton wires terminalAuthHeaders", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "../src/components/topology/LaunchCmuxButton.tsx"), "utf-8");
    expect(src).toContain("headers: terminalAuthHeaders()");
  });
});
