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
    .argument("<nodeRef>", "Node logical ID or node ID")
    .option("--hold-reason <reason>", "Reason for holding non-target seats")
    .option("--json", "JSON output")
    .action(async (rigId: string, nodeRef: string, opts: { json?: boolean; holdReason?: string }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) {
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
