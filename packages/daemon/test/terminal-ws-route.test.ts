import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { serve, type ServerType } from "@hono/node-server";
import http from "node:http";
import { registerTerminalWs } from "../src/routes/terminal-ws.js";

const TOKEN = "test-ws-route-token";
const PORT = 19876;

let server: ServerType;

beforeAll(async () => {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tmuxAdapter" as never, {
      hasSession: async () => true,
      setWindowOption: async () => ({ ok: true }),
      startPipePane: async () => ({ ok: true }),
      stopPipePane: async () => ({ ok: true }),
      sendKeys: async () => ({ ok: true }),
      sendText: async () => ({ ok: true }),
      resizeWindow: async () => ({ ok: true }),
    });
    await next();
  });
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  registerTerminalWs(app, upgradeWebSocket as never, { bearerToken: TOKEN });
  server = serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" });
  injectWebSocket(server);
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
});

afterAll(() => {
  server?.close();
});

function rawUpgrade(path: string, extraHeaders?: Record<string, string>): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: PORT,
      path,
      method: "GET",
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": Buffer.from("test-key-12345678").toString("base64"),
        "Sec-WebSocket-Version": "13",
        ...extraHeaders,
      },
    });
    req.on("response", (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body }));
    });
    req.on("upgrade", (_res, _socket, _head) => {
      resolve({ statusCode: 101, body: "" });
      _socket.destroy();
    });
    req.on("error", reject);
    req.end();
  });
}

describe("terminal WebSocket route (production path)", () => {
  it("valid token WS upgrade does NOT return 404 (the QA blocker regression)", async () => {
    const result = await rawUpgrade(
      `/api/terminal/test-session?token=${TOKEN}`,
      { Origin: "http://127.0.0.1" },
    );
    expect(result.statusCode, `expected non-404, got ${result.statusCode}: ${result.body}`).not.toBe(404);
  });

  it("missing token returns 401", async () => {
    const result = await rawUpgrade(
      "/api/terminal/test-session",
      { Origin: "http://127.0.0.1" },
    );
    expect(result.statusCode).toBe(401);
  });

  it("bad Origin returns 403", async () => {
    const result = await rawUpgrade(
      `/api/terminal/test-session?token=${TOKEN}`,
      { Origin: "http://evil.example.com" },
    );
    expect(result.statusCode).toBe(403);
  });

  it("wrong token returns 401", async () => {
    const result = await rawUpgrade(
      `/api/terminal/test-session?token=wrong`,
      { Origin: "http://127.0.0.1" },
    );
    expect(result.statusCode).toBe(401);
  });
});
