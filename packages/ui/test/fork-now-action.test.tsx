import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ForkNowAction } from "../src/components/agent-images/ForkNowAction.js";
import type { AgentImageEntry } from "../src/hooks/useAgentImageLibrary.js";

function makeEntry(overrides?: Partial<AgentImageEntry>): AgentImageEntry {
  return {
    id: "img-1",
    kind: "agent-image",
    name: "my-image",
    version: "1",
    runtime: "claude-code",
    sourceSeat: "dev.impl@test-rig",
    sourceSessionId: "sess-1",
    sourceCwd: "/project",
    notes: null,
    createdAt: "2026-06-15T00:00:00Z",
    sourceType: "user_file",
    sourcePath: "/images/my-image",
    relativePath: "my-image",
    updatedAt: "2026-06-15T00:00:00Z",
    manifestEstimatedTokens: null,
    derivedEstimatedTokens: 1000,
    files: [],
    sourceResumeToken: "(redacted)",
    stats: { forkCount: 0, lastUsedAt: null, estimatedSizeBytes: 5000, lineage: [] },
    lineage: [],
    pinned: false,
    ...overrides,
  };
}

function renderWithQuery(ui: React.ReactElement) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("ForkNowAction", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("renders Fork now button for image with sourceCwd", () => {
    renderWithQuery(<ForkNowAction entry={makeEntry()} />);
    expect(screen.getByTestId("fork-now-button")).toBeDefined();
  });

  it("disables Fork now for image with null sourceCwd (no-fallback invariant)", () => {
    renderWithQuery(<ForkNowAction entry={makeEntry({ sourceCwd: null })} />);
    expect(screen.getByTestId("fork-now-disabled-no-cwd")).toBeDefined();
    expect(screen.queryByTestId("fork-now-button")).toBeNull();
  });

  it("disables Fork now for image with empty string sourceCwd", () => {
    renderWithQuery(<ForkNowAction entry={makeEntry({ sourceCwd: "" })} />);
    expect(screen.getByTestId("fork-now-disabled-no-cwd")).toBeDefined();
  });

  it("opens modal on button click", async () => {
    renderWithQuery(<ForkNowAction entry={makeEntry()} />);
    fireEvent.click(screen.getByTestId("fork-now-button"));
    expect(screen.getByTestId("fork-now-modal")).toBeDefined();
    expect(screen.getByTestId("fork-now-rig-select")).toBeDefined();
  });

  it("confirm button is disabled without required fields", () => {
    renderWithQuery(<ForkNowAction entry={makeEntry()} />);
    fireEvent.click(screen.getByTestId("fork-now-button"));
    const confirm = screen.getByTestId("fork-now-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });
});
