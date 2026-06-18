import { describe, it, expect, vi } from "vitest";
import { DaemonClient } from "../src/client.js";

function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return handler as unknown as typeof fetch;
}

describe("DaemonClient header merge", () => {
  it("post() merges options.headers into the request", async () => {
    let capturedHeaders: Record<string, string> = {};
    const client = new DaemonClient("http://localhost:7433", {
      fetchImpl: mockFetch(async (_url, init) => {
        capturedHeaders = Object.fromEntries(
          Object.entries(init.headers as Record<string, string>),
        );
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    });

    await client.post("/test", { data: 1 }, {
      headers: { Authorization: "Bearer my-token" },
    });

    expect(capturedHeaders["Authorization"]).toBe("Bearer my-token");
    expect(capturedHeaders["Content-Type"]).toBe("application/json");
  });

  it("get() merges options.headers into the request", async () => {
    let capturedHeaders: Record<string, string> = {};
    const client = new DaemonClient("http://localhost:7433", {
      fetchImpl: mockFetch(async (_url, init) => {
        capturedHeaders = Object.fromEntries(
          Object.entries((init.headers ?? {}) as Record<string, string>),
        );
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    });

    await client.get("/test", { headers: { Authorization: "Bearer token-2" } });

    expect(capturedHeaders["Authorization"]).toBe("Bearer token-2");
  });

  it("post() without options.headers works normally", async () => {
    const client = new DaemonClient("http://localhost:7433", {
      fetchImpl: mockFetch(async () => {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    });

    const res = await client.post("/test", { data: 1 });
    expect(res.status).toBe(200);
  });
});
