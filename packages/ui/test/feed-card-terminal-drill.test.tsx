// OPR.0.3.3.20 — card-level drill to terminal preview (AC-4).
//
// Discriminator A (scope fence): the drill resolves through the session-NAME
// preview seam (/api/sessions/:sessionName/preview) — NO rigId/logicalId/
// agentActivity topology call is made.
// Discriminator B (honesty): no resolved session -> the drill renders DISABLED
// with an honest title (never an empty/wrong terminal); the label says
// captured/preview, never claims live state.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";
import { FeedCardTerminalDrill } from "../src/components/for-you/FeedCardTerminalDrill.js";

const mockFetch = vi.fn();

function withQueryClient(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function settingsResponse() {
  return {
    settings: {
      "ui.preview.refresh_interval_seconds": { value: 60, source: "default", defaultValue: 3 },
      "ui.preview.default_lines": { value: 50, source: "default", defaultValue: 50 },
    },
  };
}

describe("FeedCardTerminalDrill (AC-4)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/config") return new Response(JSON.stringify(settingsResponse()));
      if (url.includes("/api/sessions/")) {
        return new Response(JSON.stringify({
          sessionName: "dev-impl@my-rig",
          content: "agent output line",
          lines: 1,
          capturedAt: "2026-06-11T00:00:00Z",
        }));
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("clicking the drill opens the terminal preview for the resolved session via the session-name seam", async () => {
    const { getByTestId } = withQueryClient(
      <FeedCardTerminalDrill cardId="card-1" sessionName="dev-impl@my-rig" />,
    );

    fireEvent.click(getByTestId("feed-card-drill-card-1"));

    // The popover opened and the preview pane fetched the session-keyed route.
    await waitFor(() => getByTestId("feed-card-drill-card-1-terminal-popover"));
    await waitFor(() => {
      const previewCalls = mockFetch.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.includes("/api/sessions/"));
      expect(previewCalls.length).toBeGreaterThan(0);
      expect(previewCalls[0]).toContain("/api/sessions/dev-impl%40my-rig/preview");
    });
  });

  it("DISCRIMINATOR A: no topology resolution — no /api/rigs/ or agent-activity call is made", async () => {
    const { getByTestId } = withQueryClient(
      <FeedCardTerminalDrill cardId="card-2" sessionName="dev-impl@my-rig" />,
    );

    fireEvent.click(getByTestId("feed-card-drill-card-2"));
    await waitFor(() => getByTestId("feed-card-drill-card-2-terminal-popover"));

    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/api/rigs/"))).toBe(false);
    expect(urls.some((u) => u.includes("agent-activity"))).toBe(false);
  });

  it("DISCRIMINATOR B: no resolved session -> disabled drill with an honest title, no popover", () => {
    const { getByTestId, queryByTestId } = withQueryClient(
      <FeedCardTerminalDrill cardId="card-3" sessionName={undefined} />,
    );

    const drill = getByTestId("feed-card-drill-card-3") as HTMLButtonElement;
    expect(drill.disabled).toBe(true);
    expect(drill.title).toContain("No session resolved");

    fireEvent.click(drill);
    expect(queryByTestId("feed-card-drill-card-3-terminal-popover")).toBeNull();
    // Nothing was fetched — no empty/wrong terminal opened.
    const previewCalls = mockFetch.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/api/sessions/"));
    expect(previewCalls).toHaveLength(0);
  });

  it("the drill label is honest: says captured/preview, never claims live state", () => {
    const { getByTestId } = withQueryClient(
      <FeedCardTerminalDrill cardId="card-4" sessionName="dev-impl@my-rig" />,
    );

    const drill = getByTestId("feed-card-drill-card-4") as HTMLButtonElement;
    expect(drill.textContent).toContain("terminal preview");
    expect(drill.title).toContain("captured snapshot");
    // No live-state overclaim: the visible label never says "live", and the
    // only "live" in the title is the explicit "not live" disclaimer.
    expect(drill.textContent).not.toMatch(/live/i);
    expect(drill.title).toContain("not live");
    expect(drill.title.replace("not live", "")).not.toMatch(/live/i);
  });
});
