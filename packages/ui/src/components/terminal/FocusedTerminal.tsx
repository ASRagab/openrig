import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { readTerminalBearerToken } from "../mission-control/missionControlAuth.js";
import "@xterm/xterm/css/xterm.css";

const SPECIAL_KEY_MAP: Record<string, string> = {
  "\t": "Tab",
  "\r": "Enter",
  "\x7f": "BSpace",
  "\x1b": "Escape",
  "\x03": "C-c",
  "\x04": "C-d",
  "\x1a": "C-z",
  "\x0c": "C-l",
  "\x01": "C-a",
  "\x05": "C-e",
  "\x0b": "C-k",
  "\x15": "C-u",
  "\x17": "C-w",
};

const ESCAPE_SEQ_MAP: Record<string, string> = {
  "\x1b[A": "Up",
  "\x1b[B": "Down",
  "\x1b[C": "Right",
  "\x1b[D": "Left",
  "\x1b[H": "Home",
  "\x1b[F": "End",
  "\x1b[5~": "PgUp",
  "\x1b[6~": "PgDn",
  "\x1b[3~": "DC",
  "\x1b[2~": "IC",
};

const LIVE_TERMINAL_RENDER_BACKGROUND = "#0c0a09";
const LIVE_TERMINAL_COLS = 120;
const LIVE_TERMINAL_ROWS = 40;

type WsMessage = { type: "keys"; keys: string[] } | { type: "text"; text: string };

export function mapXtermInput(data: string): WsMessage[] {
  const messages: WsMessage[] = [];
  let i = 0;
  let textBuf = "";

  const flushText = () => {
    if (textBuf) { messages.push({ type: "text", text: textBuf }); textBuf = ""; }
  };

  while (i < data.length) {
    if (data[i] === "\x1b" && data[i + 1] === "[") {
      const rest = data.slice(i);
      let matched = false;
      for (const [seq, key] of Object.entries(ESCAPE_SEQ_MAP)) {
        if (rest.startsWith(seq)) {
          flushText();
          messages.push({ type: "keys", keys: [key] });
          i += seq.length;
          matched = true;
          break;
        }
      }
      if (!matched) {
        textBuf += data[i]!;
        i++;
      }
    } else {
      const key = SPECIAL_KEY_MAP[data[i]!];
      if (key) {
        flushText();
        messages.push({ type: "keys", keys: [key] });
        i++;
      } else {
        textBuf += data[i]!;
        i++;
      }
    }
  }
  flushText();
  return messages;
}

export function applyOpaqueTerminalBackground(container: HTMLElement): void {
  const surfaces = [
    container,
    container.querySelector<HTMLElement>(".xterm"),
    container.querySelector<HTMLElement>(".xterm-screen"),
    container.querySelector<HTMLElement>(".xterm-viewport"),
    container.querySelector<HTMLElement>(".xterm-rows"),
  ];
  for (const surface of surfaces) {
    if (surface) surface.style.backgroundColor = LIVE_TERMINAL_RENDER_BACKGROUND;
  }
}

export function scrollTerminalViewportToPrompt(container: HTMLElement): void {
  const scroll = () => {
    const cursor = container.querySelector<HTMLElement>("textarea.xterm-helper-textarea");
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    if (!cursor) {
      container.scrollTop = maxScrollTop;
      return;
    }

    const parsedCursorTop = Number.parseFloat(cursor.style.top);
    const cursorTop = Number.isFinite(parsedCursorTop) ? parsedCursorTop : cursor.offsetTop;
    const lineHeight = cursor.offsetHeight || 14;
    const cursorBottom = cursorTop + lineHeight;
    const desiredScrollTop = cursorBottom - container.clientHeight + lineHeight * 3;
    container.scrollTop = Math.min(maxScrollTop, Math.max(0, desiredScrollTop));
  };

  scroll();
  window.requestAnimationFrame(scroll);
  window.setTimeout(scroll, 50);
}

interface FocusedTerminalProps {
  sessionName: string;
  daemonBaseUrl?: string;
}

export function FocusedTerminal({ sessionName, daemonBaseUrl }: FocusedTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<unknown>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const promptScrollUntilRef = useRef(0);
  const [error, setError] = useState<string | null>(null);

  const disposeTerminal = useCallback(() => {
    const term = termRef.current as { dispose(): void } | null;
    term?.dispose();
    termRef.current = null;
  }, []);

  const scrollLiveTerminalToPrompt = useCallback((term: { scrollToBottom(): void } | null) => {
    if (term) {
      term.scrollToBottom();
    }
    if (containerRef.current) {
      scrollTerminalViewportToPrompt(containerRef.current);
    }
  }, []);

  const connectForGeneration = useCallback((gen: number) => {
    const base = daemonBaseUrl ?? window.location.origin;
    const wsUrl = base.replace(/^http/, "ws");
    const token = readTerminalBearerToken();
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
    const ws = new WebSocket(`${wsUrl}/api/terminal/${encodeURIComponent(sessionName)}${tokenParam}`);

    ws.onopen = () => {
      if (generationRef.current !== gen) { ws.close(); return; }
      // The daemon broker owns fixed canonical geometry (120x40). The client
      // must keep the same grid and let the UI scroll/pan smaller surfaces.
      promptScrollUntilRef.current = Date.now() + 2500;
      const term = termRef.current as { scrollToBottom(): void } | null;
      scrollLiveTerminalToPrompt(term);
    };

    ws.onmessage = (evt) => {
      if (generationRef.current !== gen) return;
      const term = termRef.current as { write(data: string): void; scrollToBottom(): void } | null;
      if (typeof evt.data === "string" && term) {
        term.write(evt.data);
        if (Date.now() <= promptScrollUntilRef.current) {
          scrollLiveTerminalToPrompt(term);
        }
      }
    };

    ws.onclose = (evt) => {
      if (generationRef.current !== gen) return;
      const definitive = evt.code === 1008 || evt.code === 1011 || evt.code === 1001;
      if (definitive) {
        disposeTerminal();
        setError(evt.reason || "Terminal unavailable: session not found on this daemon");
        return;
      }
      const term = termRef.current as { write(data: string): void } | null;
      if (term) {
        term.write("\r\n\x1b[90m[disconnected - reconnecting...]\x1b[0m\r\n");
      }
      if (mountedRef.current && generationRef.current === gen) {
        reconnectTimerRef.current = setTimeout(() => {
          if (mountedRef.current && generationRef.current === gen) connectForGeneration(gen);
        }, 3000);
      }
    };

    wsRef.current = ws;
    return ws;
  }, [sessionName, daemonBaseUrl, disposeTerminal, scrollLiveTerminalToPrompt]);

  useEffect(() => {
    if (!containerRef.current) return;
    mountedRef.current = true;
    generationRef.current++;
    const currentGen = generationRef.current;
    let cleanedUp = false;

    (async () => {
      try {
        if (cleanedUp) return;

        const term = new Terminal({
          cursorBlink: true,
          cols: LIVE_TERMINAL_COLS,
          rows: LIVE_TERMINAL_ROWS,
          fontSize: 12,
          lineHeight: 1,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          // xterm erase/redraw needs an opaque cell background. A translucent
          // xterm render surface lets old TUI cells bleed through after clear
          // screen / absolute cursor repaint, which corrupts Claude/Codex views.
          theme: { background: LIVE_TERMINAL_RENDER_BACKGROUND, foreground: "#e0e0e0", cursor: "#e0e0e0" },
          allowTransparency: false,
          allowProposedApi: true,
        });

        term.open(containerRef.current!);
        // Some xterm DOM layers do not inherit the theme background. Pin every
        // render layer opaque so clear/erase operations actually erase.
        applyOpaqueTerminalBackground(containerRef.current!);
        term.focus();
        promptScrollUntilRef.current = Date.now() + 2500;
        scrollTerminalViewportToPrompt(containerRef.current!);
        termRef.current = term;

        term.onData((data: string) => {
          const wsc = wsRef.current;
          if (!wsc || wsc.readyState !== WebSocket.OPEN) return;
          const mapped = mapXtermInput(data);
          for (const msg of mapped) {
            wsc.send(JSON.stringify(msg));
          }
        });

        // OPR.0.4.0.38 FR-7: no term.onResize -> ws resize relay. The pane
        // geometry is fixed daemon-side; the client grid matches it exactly
        // and never asks the pane to resize.

        connectForGeneration(currentGen);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terminal initialization failed");
      }
    })();

    return () => {
      cleanedUp = true;
      mountedRef.current = false;
      generationRef.current++;
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      const activeWs = wsRef.current;
      if (activeWs) { activeWs.close(); wsRef.current = null; }
      disposeTerminal();
    };
  }, [connectForGeneration, disposeTerminal]);

  if (error) {
    return (
      <div
        key={`focused-terminal-error-${sessionName}`}
        data-testid={`focused-terminal-${sessionName}`}
        className="h-full w-full min-h-[200px] flex items-center justify-center px-4 text-center text-stone-400 font-mono text-xs"
      >
        <span className="block max-w-[28ch] whitespace-normal break-all leading-relaxed">
          Terminal unavailable: {error}
        </span>
      </div>
    );
  }

  return (
    <div
      key={`focused-terminal-live-${sessionName}`}
      ref={containerRef}
      data-testid={`focused-terminal-${sessionName}`}
      className="h-full w-full min-h-[200px] overflow-auto bg-stone-950/60 backdrop-blur-sm"
    />
  );
}
