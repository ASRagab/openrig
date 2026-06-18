import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { isCodex013xOrLater } from "../src/adapters/codex-runtime-adapter.js";

const require = createRequire(import.meta.url);

describe("resume provenance + precedence", () => {
  let db: Database.Database;
  let sessionRegistry: SessionRegistry;

  beforeEach(() => {
    db = createFullTestDb();
    sessionRegistry = new SessionRegistry(db);
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.worker", { runtime: "codex" });
    sessionRegistry.registerSession(node.id, "dev-worker@test-rig");
  });

  afterEach(() => db.close());

  function getSessionId(): string {
    const row = db.prepare("SELECT id FROM sessions LIMIT 1").get() as { id: string };
    return row.id;
  }

  function getProvenance(): string | null {
    const row = db.prepare("SELECT resume_provenance FROM sessions LIMIT 1").get() as { resume_provenance: string | null };
    return row.resume_provenance;
  }

  function getToken(): string | null {
    const row = db.prepare("SELECT resume_token FROM sessions LIMIT 1").get() as { resume_token: string | null };
    return row.resume_token;
  }

  it("hook write sets provenance=hook", () => {
    sessionRegistry.updateResumeToken(getSessionId(), "codex_id", "thread-123", "hook");
    expect(getProvenance()).toBe("hook");
    expect(getToken()).toBe("thread-123");
  });

  it("scrape write sets provenance=scrape when no existing token", () => {
    sessionRegistry.updateResumeToken(getSessionId(), "codex_id", "thread-456", "scrape");
    expect(getProvenance()).toBe("scrape");
    expect(getToken()).toBe("thread-456");
  });

  it("scrape write does NOT overwrite hook-provenance token", () => {
    const id = getSessionId();
    sessionRegistry.updateResumeToken(id, "codex_id", "hook-thread", "hook");
    sessionRegistry.updateResumeToken(id, "codex_id", "scrape-thread", "scrape");
    expect(getToken()).toBe("hook-thread");
    expect(getProvenance()).toBe("hook");
  });

  it("hook write CAN overwrite scrape-provenance token", () => {
    const id = getSessionId();
    sessionRegistry.updateResumeToken(id, "codex_id", "scrape-thread", "scrape");
    sessionRegistry.updateResumeToken(id, "codex_id", "hook-thread", "hook");
    expect(getToken()).toBe("hook-thread");
    expect(getProvenance()).toBe("hook");
  });

  it("same hook token re-applied is idempotent", () => {
    const id = getSessionId();
    sessionRegistry.updateResumeToken(id, "codex_id", "thread-123", "hook");
    sessionRegistry.updateResumeToken(id, "codex_id", "thread-123", "hook");
    expect(getToken()).toBe("thread-123");
    expect(getProvenance()).toBe("hook");
  });

  it("startup-orchestrator scrape does NOT overwrite hook", () => {
    const id = getSessionId();
    sessionRegistry.updateResumeToken(id, "codex_id", "hook-thread", "hook");
    sessionRegistry.updateResumeToken(id, "codex_id", "launch-scrape-thread", "scrape");
    expect(getToken()).toBe("hook-thread");
    expect(getProvenance()).toBe("hook");
  });
});

describe("isCodex013xOrLater", () => {
  it("0.139.0 is 013x+", () => expect(isCodex013xOrLater("0.139.0")).toBe(true));
  it("0.130.0 is 013x+", () => expect(isCodex013xOrLater("0.130.0")).toBe(true));
  it("0.120.0 is NOT 013x+", () => expect(isCodex013xOrLater("0.120.0")).toBe(false));
  it("0.125.0 is NOT 013x+", () => expect(isCodex013xOrLater("0.125.0")).toBe(false));
  it("1.0.0 is 013x+", () => expect(isCodex013xOrLater("1.0.0")).toBe(true));
  it("empty string is NOT 013x+", () => expect(isCodex013xOrLater("")).toBe(false));
});

describe("activity-relay session identity", () => {
  it("buildSessionIdentityPayload extracts session_id from SessionStart", () => {
    const { buildSessionIdentityPayload } = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
    const payload = buildSessionIdentityPayload({
      hookEvent: "SessionStart",
      session_id: "thread-abc-123",
      sessionName: "dev-worker@test-rig",
      runtime: "codex",
    });
    expect(payload).not.toBeNull();
    expect(payload.eventFamily).toBe("session_identity");
    expect(payload.sessionId).toBe("thread-abc-123");
    expect(payload.sessionName).toBe("dev-worker@test-rig");
  });

  it("buildSessionIdentityPayload returns null for non-SessionStart", () => {
    const { buildSessionIdentityPayload } = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
    const payload = buildSessionIdentityPayload({
      hookEvent: "UserPromptSubmit",
      session_id: "thread-abc-123",
      sessionName: "dev-worker@test-rig",
      runtime: "codex",
    });
    expect(payload).toBeNull();
  });

  it("buildSessionIdentityPayload returns null when no session_id", () => {
    const { buildSessionIdentityPayload } = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
    const payload = buildSessionIdentityPayload({
      hookEvent: "SessionStart",
      sessionName: "dev-worker@test-rig",
      runtime: "codex",
    });
    expect(payload).toBeNull();
  });
});
