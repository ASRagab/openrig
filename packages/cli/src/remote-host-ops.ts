import { DaemonClient } from "./client.js";
import { loadHostRegistry, resolveHost, resolveRemoteBearer, classifyHttpFailedStep, classifyHttpError, hostDisplayTarget, type HttpHostEntry } from "./host-registry.js";
import { runCrossHostCommand } from "./cross-host-executor.js";
import { emitCrossHostError, emitCrossHostFailure } from "./cross-host-cli-helpers.js";
import type { FailedStep } from "./cross-host-types.js";

export interface RemoteHostDeps {
  clientFactory: (url: string) => DaemonClient;
  hostRegistryLoader?: () => ReturnType<typeof loadHostRegistry>;
}

export interface RemoteOpResult {
  ok: boolean;
  failedStep: FailedStep;
  data?: unknown;
  error?: string;
}

export async function runRemoteHttpOp(
  hostId: string,
  method: "GET" | "POST",
  apiPath: string,
  body: unknown | undefined,
  deps: RemoteHostDeps,
  opts: { json?: boolean },
): Promise<RemoteOpResult> {
  const loader = deps.hostRegistryLoader ?? loadHostRegistry;
  const registry = loader();
  if (!registry.ok) {
    return { ok: false, failedStep: "remote-daemon-unreachable", error: registry.error };
  }
  const resolved = resolveHost(registry.registry, hostId);
  if (!resolved.ok) {
    return { ok: false, failedStep: "remote-daemon-unreachable", error: resolved.error };
  }
  const host = resolved.host;

  if (host.transport === "ssh") {
    return { ok: false, failedStep: "remote-command-failed", error: `host ${hostId} uses SSH transport; HTTP --host not available` };
  }

  const httpHost = host as HttpHostEntry;
  const bearerResult = resolveRemoteBearer(httpHost);
  if (!bearerResult.ok) {
    return { ok: false, failedStep: bearerResult.failedStep, error: bearerResult.error };
  }

  const client = deps.clientFactory(httpHost.url);
  const headers = { Authorization: `Bearer ${bearerResult.token}` };

  try {
    const res = method === "POST"
      ? await client.post<unknown>(apiPath, body, { headers })
      : await client.get<unknown>(apiPath, { headers });

    const failedStep = classifyHttpFailedStep(res.status);
    if (failedStep !== "none") {
      return { ok: false, failedStep, error: `HTTP ${res.status}` };
    }
    return { ok: true, failedStep: "none", data: res.data };
  } catch (err) {
    return { ok: false, failedStep: classifyHttpError(err), error: (err as Error).message };
  }
}
