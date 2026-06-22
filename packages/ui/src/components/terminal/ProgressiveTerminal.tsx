// OPR.0.4.0.1 — the ONE reusable progressive-live terminal (AC-3).
//
// Default-static -> click-inside-to-go-live (founder directive): on open it shows
// the cheap static polling preview (SessionPreviewPane); a click anywhere inside
// upgrades THAT terminal to a live, typeable FocusedTerminal. Going live consults
// the global LiveTerminalProvider cap: if over MAX_LIVE_TERMINALS the OLDEST live
// terminal is evicted back to static (its revert callback runs, closing its WS).
// Static previews are uncapped (cheap polling). Used by all three surfaces.

import { useCallback, useEffect, useRef, useState } from "react";
import { FocusedTerminal } from "./FocusedTerminal.js";
import { StaticTerminalPlate } from "./StaticTerminalPlate.js";
import { useLiveTerminal } from "./LiveTerminalProvider.js";
import { cn } from "../../lib/utils.js";

// OPR.0.4.0.39 FR-1: the shared static-terminal plate now owns
// SMOKED_STATIC_PLATE_CLASS; re-export here for existing importers.
export { SMOKED_STATIC_PLATE_CLASS } from "./StaticTerminalPlate.js";

interface ProgressiveTerminalProps {
  sessionName: string;
  /** Stable global key for the cap registry (e.g. `${rigId}:${logicalId}`). */
  terminalKey: string;
  lines?: number;
  testIdPrefix?: string;
  className?: string;
  /** OPR.0.4.0.1: notified when this terminal flips static<->live, so a host
   *  (e.g. the popover) can size its shell to the wide live plate when live and
   *  stay compact when static. */
  onLiveChange?: (isLive: boolean) => void;
}

export function ProgressiveTerminal({
  sessionName,
  terminalKey,
  lines = 20,
  testIdPrefix = "progressive-terminal",
  className,
  onLiveChange,
}: ProgressiveTerminalProps) {
  const [mode, setMode] = useState<"static" | "live">("static");
  const live = useLiveTerminal();
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const goStatic = useCallback(() => setMode("static"), []);

  // OPR.0.4.0.1: surface the live/static mode to the host so a popover can widen
  // its shell to the full live plate when live and stay compact when static.
  useEffect(() => {
    onLiveChange?.(mode === "live");
  }, [mode, onLiveChange]);

  const goLive = useCallback(() => {
    if (modeRef.current === "live") return;
    // requestLive may evict the OLDEST live terminal (reverting it to static).
    live.requestLive(terminalKey, goStatic);
    setMode("live");
  }, [live, terminalKey, goStatic]);

  // Free the registry slot whenever we leave live (unmount or revert-to-static).
  // release() is idempotent, so an eviction (which already removed the key) is safe.
  useEffect(() => {
    if (mode !== "live") return undefined;
    return () => live.release(terminalKey);
  }, [mode, live, terminalKey]);

  if (mode === "live") {
    return (
      <div data-testid={`${testIdPrefix}-live`} className={cn("h-full w-full", className)}>
        <FocusedTerminal sessionName={sessionName} />
      </div>
    );
  }

  // Static default: the whole preview is the click target to go live. The shared
  // StaticTerminalPlate carries the smoked-glass plate + the OPAQUE #0c0a09
  // compact preview content (mirrors the live look post-38-forward-fix; FR-1).
  return (
    <StaticTerminalPlate
      sessionName={sessionName}
      lines={lines}
      plateTestId={`${testIdPrefix}-static`}
      previewTestIdPrefix={`${testIdPrefix}-preview`}
      className={className}
      onClick={goLive}
      ariaLabel={`Make ${sessionName} terminal live (typeable)`}
      title="Click to go live (typeable)"
    />
  );
}
