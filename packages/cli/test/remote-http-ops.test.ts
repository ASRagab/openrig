import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import type { DaemonClient, DaemonResponse } from "../src/client.js";

function mockClient(responses: Record<string, { status: number; data: unknown }>): DaemonClient & { _calls: Array<{ method: string; path: string; body?: unknown; headers?: Record<string, string> }> } {
  const calls: Array<{ method: string; path: string; body?: unknown; headers?: Record<string, string> }> = [];
  return {
    baseUrl: "http://remote:7433",
    get: async <T>(path: string, options?: { headers?: Record<string, string> }) => {
      calls.push({ method: "GET", path, headers: options?.headers });
      const r = responses[path] ?? { status: 404, data: { error: "not found" } };
      return { status: r.status, data: r.data as T } as DaemonResponse<T>;
    },
    post: async <T>(path: string, body?: unknown, options?: { headers?: Record<string, string> }) => {
      calls.push({ method: "POST", path, body, headers: options?.headers });
      const r = responses[path] ?? { status: 200, data: { ok: true } };
      return { status: r.status, data: r.data as T } as DaemonResponse<T>;
    },
    _calls: calls,
  } as unknown as DaemonClient & { _calls: typeof calls };
}

function mockRegistry(hosts: Array<Record<string, unknown>>) {
  return () => ({ ok: true as const, registry: { hosts } });
}

async function captureLogs(fn: () => Promise<void>): Promise<{ stdout: string[]; stderr: string[]; exitCode: number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origStdout = process.stdout.write;
  const origStderr = process.stderr.write;
  const origExit = process.exitCode;
  process.exitCode = undefined;
  console.log = (...args: unknown[]) => { stdout.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(" ")); };
  process.stdout.write = ((c: unknown) => { stdout.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => { stderr.push(String(c)); return true; }) as typeof process.stderr.write;
  try { await fn(); } catch {}
  const exitCode = process.exitCode;
  console.log = origLog;
  console.error = origErr;
  process.stdout.write = origStdout;
  process.stderr.write = origStderr;
  process.exitCode = origExit;
  return { stdout, stderr, exitCode };
}

afterEach(() => { vi.unstubAllEnvs(); });

describe("rig up --host HTTP", () => {
  it("sends correct body shape with remote bearer", async () => {
    vi.stubEnv("HOST_B_TOKEN", "remote-tok");
    const client = mockClient({ "/api/up": { status: 200, data: { ok: true, rigId: "r1" } } });
    const { upCommand } = await import("../src/commands/up.js");
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(upCommand({
      lifecycleDeps: {} as any,
      clientFactory: () => client,
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://remote:7433", bearer_env: "HOST_B_TOKEN" },
      ]),
    } as any));
    await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "up", "my-rig.yaml", "--host", "host-b", "--yes", "--cwd", "/work", "--json"]);
    });
    const postCalls = client._calls.filter((c) => c.method === "POST" && c.path === "/api/up");
    expect(postCalls.length).toBe(1);
    expect(postCalls[0]!.body).toMatchObject({ sourceRef: "my-rig.yaml", autoApprove: true, cwdOverride: "/work" });
    expect(postCalls[0]!.headers?.Authorization).toBe("Bearer remote-tok");
  });

  it("missing bearer exits nonzero under --json", async () => {
    delete process.env.MISSING_TOK;
    const client = mockClient({});
    const { upCommand } = await import("../src/commands/up.js");
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(upCommand({
      lifecycleDeps: {} as any,
      clientFactory: () => client,
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://remote:7433", bearer_env: "MISSING_TOK" },
      ]),
    } as any));
    const { exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "up", "spec.yaml", "--host", "host-b", "--json"]);
    });
    expect(client._calls.length).toBe(0);
    expect(exitCode).toBe(1);
  });
});

describe("rig down --host HTTP", () => {
  it("resolves rig name via remote /api/ps then posts resolved id", async () => {
    vi.stubEnv("HOST_B_TOKEN", "remote-tok");
    const client = mockClient({
      "/api/ps?includeArchived=true": { status: 200, data: [{ rigId: "rig-abc", name: "my-rig" }] },
      "/api/down": { status: 200, data: { ok: true } },
    });
    const { downCommand } = await import("../src/commands/down.js");
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(downCommand({
      lifecycleDeps: {} as any,
      clientFactory: () => client,
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://remote:7433", bearer_env: "HOST_B_TOKEN" },
      ]),
    } as any));
    await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "down", "my-rig", "--host", "host-b", "--json"]);
    });
    const downCalls = client._calls.filter((c) => c.method === "POST" && c.path === "/api/down");
    expect(downCalls.length).toBe(1);
    expect(downCalls[0]!.body).toMatchObject({ rigId: "rig-abc" });
    expect(downCalls[0]!.headers?.Authorization).toBe("Bearer remote-tok");
  });

  it("ambiguous name exits nonzero with no /api/down request", async () => {
    vi.stubEnv("HOST_B_TOKEN", "remote-tok");
    const client = mockClient({
      "/api/ps?includeArchived=true": { status: 200, data: [
        { rigId: "r1", name: "dup" },
        { rigId: "r2", name: "dup" },
      ] },
    });
    const { downCommand } = await import("../src/commands/down.js");
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(downCommand({
      lifecycleDeps: {} as any,
      clientFactory: () => client,
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://remote:7433", bearer_env: "HOST_B_TOKEN" },
      ]),
    } as any));
    const { exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "down", "dup", "--host", "host-b", "--json"]);
    });
    const downCalls = client._calls.filter((c) => c.path === "/api/down");
    expect(downCalls.length).toBe(0);
    expect(exitCode).toBe(1);
  });
});

describe("rig whoami --host HTTP", () => {
  it("returns remote identity from /api/info + /api/ps with bearer", async () => {
    vi.stubEnv("HOST_B_TOKEN", "remote-tok");
    const client = mockClient({
      "/api/info": { status: 200, data: { installRoot: "/opt/openrig" } },
      "/api/ps": { status: 200, data: [{ rigId: "r1", name: "my-rig" }] },
    });
    const { whoamiCommand } = await import("../src/commands/whoami.js");
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(whoamiCommand({
      lifecycleDeps: {} as any,
      clientFactory: () => client,
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://remote:7433", bearer_env: "HOST_B_TOKEN" },
      ]),
    } as any));
    const { stdout } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "whoami", "--host", "host-b", "--json"]);
    });
    const parsed = JSON.parse(stdout.join(""));
    expect(parsed.host).toBe("host-b");
    expect(parsed.installRoot).toBe("/opt/openrig");
    expect(parsed.rigs).toEqual([{ id: "r1", name: "my-rig" }]);
    const infoCalls = client._calls.filter((c) => c.path === "/api/info");
    expect(infoCalls[0]!.headers?.Authorization).toBe("Bearer remote-tok");
  });

  it("non-2xx /api/info fails without fake identity", async () => {
    vi.stubEnv("HOST_B_TOKEN", "remote-tok");
    const client = mockClient({
      "/api/info": { status: 401, data: { error: "unauthorized" } },
    });
    const { whoamiCommand } = await import("../src/commands/whoami.js");
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(whoamiCommand({
      lifecycleDeps: {} as any,
      clientFactory: () => client,
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://remote:7433", bearer_env: "HOST_B_TOKEN" },
      ]),
    } as any));
    const { stdout, exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "whoami", "--host", "host-b", "--json"]);
    });
    expect(exitCode).toBe(1);
    const output = stdout.join("");
    expect(output).not.toContain("installRoot");
  });
});
