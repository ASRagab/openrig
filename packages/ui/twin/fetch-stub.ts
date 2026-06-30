// Daemon-free fetch seam (complements cache-seed; NOT MSW / no service worker).
// Cache-seed (seed.ts) gives instant first paint, but several hooks hardcode
// staleTime:0 + refetchInterval (useNodePreview/useSessionPreview, useSettings,
// useSpecLibrary, useContextFleet, useFiles) and BACKGROUND-REFETCH even when seeded —
// with no daemon those reject and surface "Failed to fetch". This thin fetch override
// answers /api/* from the SAME typed fixtures so the force-refetch hooks resolve to fixture
// data and the twin stays 1:1 and daemon-free. Default for any unmapped /api/* is a benign
// 404 "unavailable" (the hooks' graceful-degrade path), never a rejected fetch.

import {
  rigSummary,
  psEntries,
  specLibrary,
  nodeInventoryByRig,
  rigGraphByRig,
  nodeDetailByKey,
  sessionPreviewByName,
  sliceList,
  steeringPayload,
  missionBriefMd,
  artifactsTreeByPath,
} from "./fixtures.js";

// Mission workspace root (matches /api/config workspace.root); the Steering
// tab's brief reads MISSION_BRIEF.md relative to a files-root containing the mission path.
const TWIN_WORKSPACE_ROOT = "/Users/x/code/workspace";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const realFetch: typeof fetch | undefined = globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined;

function route(pathname: string, search: URLSearchParams): Response {
  if (pathname === "/api/rigs/summary") return json(rigSummary);
  if (pathname === "/api/ps") return json(psEntries);
  // Settings (useSettings, staleTime:0). workspace.root unblocks the /project surface
  // (useWorkspaceName); preview settings keep the terminal pane consistent.
  if (pathname === "/api/config") {
    return json({
      settings: {
        "workspace.root": { value: "/Users/x/code/workspace", source: "config", defaultValue: "" },
        "ui.preview.default_lines": { value: 100, source: "default", defaultValue: 100 },
        "ui.preview.refresh_interval_seconds": { value: 3, source: "default", defaultValue: 3 },
      },
    });
  }
  if (pathname.startsWith("/api/spec-library") || pathname.startsWith("/api/library")) return json(specLibrary);
  // Workspace slices (the /project surface; missions derive from these).
  if (pathname === "/api/slices") return json(sliceList);

  // Mission Steering tab.
  // Panel 1: GET /api/steering -> the STEERING.md projection payload.
  if (pathname === "/api/steering") return json(steeringPayload);
  // useMission -> mission root path (Panel 2 reads MISSION_BRIEF.md relative to it).
  let mm = pathname.match(/^\/api\/missions\/([^/]+)$/);
  if (mm) {
    const missionId = decodeURIComponent(mm[1]!);
    return json({ missionId, missionPath: `${TWIN_WORKSPACE_ROOT}/missions/${missionId}`, slices: [] });
  }
  // useFilesRoots -> a root that CONTAINS the mission path (so useScopeMarkdown resolves).
  if (pathname === "/api/files/roots") {
    return json({ roots: [{ name: "workspace", path: TWIN_WORKSPACE_ROOT }] });
  }
  // useFilesList (the Artifacts navigator): per-folder entries.
  if (pathname === "/api/files/list") {
    const p = search.get("path") ?? "";
    return json({ root: "workspace", path: p, entries: artifactsTreeByPath[p] ?? [] });
  }
  // useFilesRead -> serve the MISSION_BRIEF.md content (Panel 2); other files unavailable.
  if (pathname === "/api/files/read") {
    const p = search.get("path") ?? "";
    if (p.endsWith("MISSION_BRIEF.md")) {
      return json({ content: missionBriefMd, mtime: "2026-06-23T08:30:00.000Z", contentHash: "twin-brief" });
    }
    return json({ error: "not_found" }, 404);
  }

  // Embedded terminal preview (session-keyed).
  let m = pathname.match(/^\/api\/sessions\/([^/]+)\/preview$/);
  if (m) {
    const name = decodeURIComponent(m[1]!);
    const lines = Number(search.get("lines") ?? 100);
    const fx = sessionPreviewByName[name];
    // Echo the requested line count; content is the same dummy regardless of N.
    return fx ? json({ ...fx, lines }) : json({ unavailable: true, reason: "preview_unavailable" }, 404);
  }
  // Node-keyed preview is unused on the seeded surfaces -> graceful unavailable.
  if (/^\/api\/rigs\/[^/]+\/nodes\/[^/]+\/preview$/.test(pathname)) {
    return json({ unavailable: true, reason: "preview_unavailable" }, 404);
  }

  m = pathname.match(/^\/api\/rigs\/([^/]+)\/nodes\/([^/]+)$/);
  if (m) {
    const detail = nodeDetailByKey[`${decodeURIComponent(m[1]!)}::${decodeURIComponent(m[2]!)}`];
    return detail ? json(detail) : json({ error: "not_found" }, 404);
  }
  m = pathname.match(/^\/api\/rigs\/([^/]+)\/nodes$/);
  if (m) return json(nodeInventoryByRig[decodeURIComponent(m[1]!)] ?? []);
  m = pathname.match(/^\/api\/rigs\/([^/]+)\/graph$/);
  if (m) return json(rigGraphByRig[decodeURIComponent(m[1]!)] ?? { nodes: [], edges: [] });

  // Benign default: graceful "unavailable", never a rejected fetch.
  return json({ unavailable: true, reason: "twin_offline" }, 404);
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  try {
    const u = new URL(url, "http://twin.local");
    if (u.pathname.startsWith("/api/")) return route(u.pathname, u.searchParams);
  } catch {
    /* fall through to real fetch */
  }
  if (realFetch) return realFetch(input, init);
  return json({ unavailable: true, reason: "twin_offline" }, 404);
}) as typeof fetch;

export {};
