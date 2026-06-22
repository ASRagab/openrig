// OPR.0.4.0.39 - the ONE shared static-terminal component.
//
// Backs EVERY static polling-preview terminal (the topology grid thumbnail and
// ProgressiveTerminal's static mode) with the SAME borderless smoked-glass plate
// (SMOKED_STATIC_PLATE_CLASS) wrapping the compact SessionPreviewPane. The
// preview content mirrors the post-38-forward-fix LIVE look (212b4523): OPAQUE
// #0c0a09 content within the smoke plate - the same opaque terminal content the
// live xterm now renders, NOT the old translucent tint. Consolidates the
// duplicated plate+preview pattern so every static terminal is consistent and
// upgrades to live via the existing click-to-live model (FR-6).

import { SessionPreviewPane } from "../preview/SessionPreviewPane.js";
import { cn } from "../../lib/utils.js";

/** The borderless smoked-glass plate every static-terminal preview carries so it
 *  reads as floating glass on the truly-bare surfaces (topology tab / grid),
 *  matching the live look. Defined here as the shared static-terminal home;
 *  ProgressiveTerminal re-exports it for existing importers. */
export const SMOKED_STATIC_PLATE_CLASS = "bg-stone-950/60 backdrop-blur-sm";

interface StaticTerminalPlateProps {
  sessionName: string;
  lines?: number;
  /** data-testid for the plate element (button when onClick, div otherwise). */
  plateTestId?: string;
  /** testIdPrefix passed through to the inner SessionPreviewPane. */
  previewTestIdPrefix?: string;
  className?: string;
  /** When provided, the plate is itself the click-to-live target (a button). */
  onClick?: () => void;
  ariaLabel?: string;
  title?: string;
}

/**
 * The shared static-terminal plate. With `onClick` it renders as the
 * click-to-live button (ProgressiveTerminal's static mode); without it, a plain
 * plate (the topology grid thumbnail, whose click-to-live is the separate
 * TerminalPreviewPopover trigger).
 */
export function StaticTerminalPlate({
  sessionName,
  lines,
  plateTestId,
  previewTestIdPrefix,
  className,
  onClick,
  ariaLabel,
  title,
}: StaticTerminalPlateProps) {
  const preview = (
    <SessionPreviewPane
      sessionName={sessionName}
      lines={lines}
      variant="compact-terminal"
      testIdPrefix={previewTestIdPrefix}
    />
  );

  if (onClick) {
    return (
      <button
        type="button"
        data-testid={plateTestId}
        aria-label={ariaLabel}
        title={title}
        onClick={onClick}
        className={cn("block h-full w-full cursor-pointer text-left", SMOKED_STATIC_PLATE_CLASS, className)}
      >
        {preview}
      </button>
    );
  }

  return (
    <div data-testid={plateTestId} className={cn(SMOKED_STATIC_PLATE_CLASS, className)}>
      {preview}
    </div>
  );
}
