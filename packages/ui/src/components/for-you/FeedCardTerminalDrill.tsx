// OPR.0.3.3.20 — For-You card-level drill into the source/author seat's
// terminal PREVIEW (manage-by-exception, video B6).
//
// Session-NAME keyed only: the drill reuses TerminalPreviewPopover /
// SessionPreviewPane over GET /api/sessions/:sessionName/preview. It performs
// NO rigId/logicalId/agentActivity topology resolution — the card's already-
// resolved source session string is the whole address (the 0.4.0 detection
// layer stays untouched).
//
// Honesty: the preview is a CAPTURED snapshot at capturedAt, not a live-state
// guarantee — the affordance says "preview"/"captured", never "live". When no
// session resolves for the card, the drill renders DISABLED with an honest
// title instead of opening an empty/wrong terminal.

import { TerminalPreviewPopover } from "../topology/TerminalPreviewPopover.js";

// Same event contract TopologyTerminalView uses to drive the shared popover
// from an externally-owned trigger.
const TERMINAL_PREVIEW_EVENT = "openrig:topology-terminal-preview";

interface FeedCardTerminalDrillProps {
  cardId: string;
  /** The card's resolved source/author session ("that seat"); undefined when
   *  no session resolves — renders the honest disabled state. */
  sessionName: string | undefined;
}

export function FeedCardTerminalDrill({ cardId, sessionName }: FeedCardTerminalDrillProps) {
  if (!sessionName) {
    return (
      <button
        type="button"
        disabled
        data-testid={`feed-card-drill-${cardId}`}
        title="No session resolved for this card — terminal preview unavailable"
        className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-stone-400 cursor-not-allowed"
      >
        terminal preview
      </button>
    );
  }

  // Key matches TerminalPreviewPopover's `${rigId ?? "unknown"}:${logicalId}`.
  // cardId namespaces it so two cards for the same session don't share a
  // popover. Both halves are plain strings already on the card — no lookup.
  const previewKey = `${cardId}:${sessionName}`;

  const openPreview = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    window.dispatchEvent(new CustomEvent(TERMINAL_PREVIEW_EVENT, { detail: { key: previewKey } }));
  };

  return (
    <span className="inline-flex items-center">
      <button
        type="button"
        data-testid={`feed-card-drill-${cardId}`}
        onClick={openPreview}
        title={`Terminal preview for ${sessionName} — captured snapshot, not live`}
        className="font-mono text-[10px] uppercase tracking-wide text-stone-700 hover:text-stone-900 underline"
      >
        terminal preview
      </button>
      <TerminalPreviewPopover
        rigId={cardId}
        logicalId={sessionName}
        sessionName={sessionName}
        renderTrigger={false}
        testIdPrefix={`feed-card-drill-${cardId}`}
      />
    </span>
  );
}
