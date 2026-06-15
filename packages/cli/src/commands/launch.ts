import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

type LaunchResponse = {
  ok: boolean;
  rigId?: string;
  nodeId?: string;
  logicalId?: string;
  sessionName?: string;
  error?: string;
  code?: string;
  launched?: Array<{ nodeId: string; logicalId: string; status: string }>;
  held?: Array<{ nodeId: string; logicalId: string; reason: string }>;
  alreadyRunning?: Array<{ nodeId: string; logicalId: string }>;
  failedTargets?: Array<{ nodeId: string; logicalId: string; reason: string }>;
};

export function launchCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("launch").description("Launch or relaunch a node in a running rig");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (status.state !== "running" || status.healthy === false) {
      console.error("Daemon not running. Start it with: rig daemon start");
      return null;
    }
    return deps.clientFactory(getDaemonUrl(status));
  }

  cmd
    .argument("<rigId>", "Target rig ID")
    .argument("[nodeRef]", "Node logical ID or node ID (single target)")
    .option("--seats <ids>", "Comma-separated logical IDs for subset launch")
    .option("--hold-reason <reason>", "Reason for holding non-target seats")
    .option("--json", "JSON output")
    .action(async (rigId: string, nodeRef: string | undefined, opts: { json?: boolean; holdReason?: string; seats?: string }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) {
        process.exitCode = 1;
        return;
      }

      const seatList = opts.seats ? opts.seats.split(",").map((s) => s.trim()).filter(Boolean) : [];

      if (seatList.length > 0) {
        const body: { seats: string[]; holdReason?: string } = { seats: seatList };
        if (opts.holdReason) body.holdReason = opts.holdReason;
        const res = await client.post<LaunchResponse>(`/api/rigs/${encodeURIComponent(rigId)}/nodes/launch-subset`, body);
        if (opts.json) {
          console.log(JSON.stringify(res.data, null, 2));
          if (res.status >= 400) process.exitCode = 1;
          return;
        }
        if (res.status >= 400 || !res.data.ok) {
          console.error(res.data.error ?? `Launch failed (HTTP ${res.status})`);
          process.exitCode = 1;
          return;
        }
        const launchedIds = (res.data.launched ?? []).map((n) => n.logicalId).join(", ");
        const heldIds = (res.data.held ?? []).map((n) => `${n.logicalId} (${n.reason})`).join(", ");
        if (launchedIds) console.log(`Launched: ${launchedIds}`);
        if (heldIds) console.log(`Held: ${heldIds}`);
        if (res.data.alreadyRunning?.length) console.log(`Already running: ${res.data.alreadyRunning.map((n) => n.logicalId).join(", ")}`);
        if (res.data.failedTargets?.length) {
          console.error(`Failed (liveness unknown): ${res.data.failedTargets.map((n) => n.logicalId).join(", ")}`);
          process.exitCode = 1;
        }
        return;
      }

      if (!nodeRef) {
        console.error("Provide a node logical ID or use --seats <a,b> for subset launch");
        process.exitCode = 1;
        return;
      }

      const body: Record<string, string> = {};
      if (opts.holdReason) body.holdReason = opts.holdReason;

      const res = await client.post<LaunchResponse>(`/api/rigs/${encodeURIComponent(rigId)}/nodes/${encodeURIComponent(nodeRef)}/launch`, body);
      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        if (res.status >= 400) process.exitCode = 1;
        return;
      }

      if (res.status >= 400 || !res.data.ok) {
        console.error(res.data.error ?? `Launch failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      const logicalId = res.data.logicalId ?? nodeRef;
      const sessionSuffix = res.data.sessionName ? ` (${res.data.sessionName})` : "";
      console.log(`Launched node ${logicalId} in rig ${rigId}${sessionSuffix}`);
    });

  return cmd;
}
