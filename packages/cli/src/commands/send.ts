import { Command } from "commander";
import { DaemonClient, terminalAuthHeaders } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { loadHostRegistry, resolveHost, hostDisplayTarget } from "../host-registry.js";
import { runCrossHostCommand, type RunCrossHostCommandOpts } from "../cross-host-executor.js";
import { emitCrossHostError, emitCrossHostFailure } from "../cross-host-cli-helpers.js";
import { readOpenRigEnv } from "../openrig-compat.js";

const WAIT_FOR_IDLE_REQUEST_OVERHEAD_MS = 5_000;

const SENDER_FALLBACK = "<unknown sender>";

/**
 * Wrap a `rig send` body with an email-style envelope so the recipient
 * pane has both the sender's identity and a copy-pasteable reply hint.
 * Cross-host sends do NOT wrap locally: the remote rig wraps when it
 * runs the same command, and double-wrapping would nest envelopes.
 *
 * V0.3.1 slice 23 parity contract: `packages/daemon/src/lib/pane-envelope.ts`
 * exports `wrapPaneEnvelope` with BYTE-IDENTICAL output for the same
 * inputs. The two implementations live in separate packages because
 * cli + daemon don't cross-import today. Daemon-side nudges from
 * `rig queue create|handoff` use the daemon helper so queue nudges
 * render the same envelope as peer-to-peer `rig send`. If you update
 * this function, update wrapPaneEnvelope in lockstep.
 */
export function wrapSendBody(sender: string | undefined, recipient: string, body: string): string {
  const senderLabel = sender && sender.trim().length > 0 ? sender : SENDER_FALLBACK;
  return [
    `From: ${senderLabel}`,
    `To: ${recipient}`,
    "---",
    body,
    "---",
    `↩ Reply: rig send ${senderLabel} "..."`,
  ].join("\n");
}

function resolveSenderSession(): string | undefined {
  return readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME");
}

export interface SendDeps extends StatusDeps {
  /**
   * Cross-host hooks. Both default to the production loaders/executors; tests
   * inject in-package mocks so no real ssh / no real ~/.ssh / no real network
   * is touched.
   */
  hostRegistryLoader?: () => ReturnType<typeof loadHostRegistry>;
  crossHostRun?: (
    host: Parameters<typeof runCrossHostCommand>[0],
    argv: readonly string[],
    opts?: RunCrossHostCommandOpts,
  ) => ReturnType<typeof runCrossHostCommand>;
}

export function sendCommand(depsOverride?: SendDeps): Command {
  const cmd = new Command("send").description("Send a message to an agent's terminal");
  const getDeps = (): SendDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .argument("<session>", "Target session name (e.g. dev-impl@my-rig)")
    .argument("<text>", "Message text to send")
    .option("--verify", "Verify pane only delivery by checking content after send")
    .option("--force", "Send even if target pane appears mid-task (does NOT bypass the interactive-prompt/permission guard)")
    .option("--wait-for-idle <seconds>", "Wait until the target is explicitly idle before sending")
    .option("--raw", "Send exact text/keystrokes without the From/To messaging envelope (still guarded against interactive prompts)")
    .option("--dangerously-interact", "DANGEROUS: deliberately drive an interactive prompt/permission block (implies --raw; requires --reason). The ONLY override of the prompt/permission guard.")
    .option("--reason <text>", "Why the prompt is being driven (required with --dangerously-interact; recorded in the audit log)")
    .option("--host <id>", "Run on a remote host declared in ~/.openrig/hosts.yaml (CLI-side ssh shell-out)")
    .option("--json", "JSON output for agents")
    .addHelpText("after", `
Examples:
  rig send dev-impl@my-rig "Context update: QA approved. Proceed."
  rig send dev-impl@my-rig "message" --verify
  rig send dev-impl@my-rig "safe proof prompt" --wait-for-idle 30 --verify
  rig send dev-impl@my-rig "Stop and read the spec." --force
  rig send dev-impl@my-rig "message" --json
  rig send --host vm-claude-test dev-impl@my-rig "remote message" --verify

The two-step send pattern (paste text, wait, submit Enter) is handled
automatically. By default a send is REFUSED when the target is at an interactive
prompt or permission block (so a message can never select/approve another agent's
prompt), and fails closed when the target's activity can't be determined. Use
--wait-for-idle to send only after explicit idle evidence. Use --verify to confirm
the message appeared in the pane only; it is not agent acknowledgement.

Use --force to override the mid-task busy check; it does NOT bypass the
interactive-prompt/permission guard. Use --raw to send exact text/keystrokes
without the From/To envelope (e.g. a slash command); it is still guarded. Use
--dangerously-interact --reason "<why>" to DELIBERATELY drive a prompt (select an
option, approve a permission, send /compact to a blocked pane) — the only override
of the prompt guard; it implies --raw and is audit-logged.

--host runs the same command on a remote host declared in ~/.openrig/hosts.yaml
via single-hop ssh. SSH success is NOT verify success: the remote rig's
'Verified: yes/no' line is what counts and is surfaced verbatim.`)
    .action(async (session: string, text: string, opts: { verify?: boolean; force?: boolean; waitForIdle?: string; raw?: boolean; dangerouslyInteract?: boolean; reason?: string; host?: string; json?: boolean }) => {
      const waitForIdleMs = parseWaitForIdleMs(opts.waitForIdle);
      if (opts.force && waitForIdleMs !== undefined) {
        console.error("--wait-for-idle cannot be combined with --force");
        process.exitCode = 1;
        return;
      }
      if (waitForIdleMs === null) {
        console.error("--wait-for-idle must be a positive number of seconds");
        process.exitCode = 1;
        return;
      }
      // OPR.0.4.1.10 — the danger override requires a reason (for the audit) and cannot compose with
      // wait mode. Reject locally before contacting the daemon.
      if (opts.dangerouslyInteract && (!opts.reason || opts.reason.trim().length === 0)) {
        console.error("--dangerously-interact requires --reason \"<why>\" (recorded in the audit log)");
        process.exitCode = 1;
        return;
      }
      if (opts.dangerouslyInteract && waitForIdleMs !== undefined) {
        console.error("--dangerously-interact cannot be combined with --wait-for-idle");
        process.exitCode = 1;
        return;
      }

      const deps = getDeps();

      // --- Cross-host short-circuit (CLI-side ssh shell-out; daemon untouched) ---
      if (opts.host) {
        await runCrossHostSend(opts.host, session, text, opts, deps);
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);

      if (status.state !== "running" || status.healthy === false) {
        console.error("Daemon not running. Start it with: rig daemon start");
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(getDaemonUrl(status));
      const senderSession = resolveSenderSession();
      // --raw (and --dangerously-interact, which implies it) send EXACT text with no messaging envelope.
      const raw = Boolean(opts.raw || opts.dangerouslyInteract);
      const outboundText = raw ? text : wrapSendBody(senderSession, session, text);
      const res = await client.post<Record<string, unknown>>("/api/transport/send", {
        session, text: outboundText, verify: opts.verify, force: opts.force, waitForIdleMs,
        dangerouslyInteract: opts.dangerouslyInteract, reason: opts.reason, actorSession: senderSession ?? null,
      }, { ...waitForIdleRequestOptions(waitForIdleMs), headers: terminalAuthHeaders() });

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }

      if (res.status >= 400) {
        const error = res.data["error"] as string | undefined;
        console.error(error ?? `Send failed (HTTP ${res.status})`);
        process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }

      console.log(`Sent to ${session}`);
      if (opts.verify) {
        // Legacy line preserved verbatim (existing scripts grep `Verified:`);
        // the Delivery line below carries the honest three-outcome vocabulary
        // (OPR.99.0.6.3): `Verified: no` alone collapsed a landed-but-redraw-
        // raced send into the same line as a miss.
        const verified = res.data["verified"] as boolean | undefined;
        console.log(`Verified: ${verified ? "yes" : "no"}`);
        const outcome = res.data["outcome"] as string | undefined;
        if (outcome === "delivered") {
          console.log("Delivery: delivered (message landed; render confirmed)");
        } else if (outcome === "rendered-unconfirmed") {
          console.log(`Delivery: rendered-unconfirmed (landed; pane re-render not confirmed - confirm with: rig capture ${session})`);
        }
      }
    });

  return cmd;
}

async function runCrossHostSend(
  hostId: string,
  session: string,
  text: string,
  opts: { verify?: boolean; force?: boolean; waitForIdle?: string; raw?: boolean; dangerouslyInteract?: boolean; reason?: string; json?: boolean },
  deps: SendDeps,
): Promise<void> {
  const loader = deps.hostRegistryLoader ?? loadHostRegistry;
  const runner = deps.crossHostRun ?? runCrossHostCommand;

  const registry = loader();
  if (!registry.ok) {
    emitCrossHostError(hostId, "registry-load-failed", registry.error, opts.json);
    return;
  }
  const resolved = resolveHost(registry.registry, hostId);
  if (!resolved.ok) {
    emitCrossHostError(hostId, "unknown-host", resolved.error, opts.json);
    return;
  }
  const host = resolved.host;

  // Reconstruct argv for the remote `rig send` invocation. Order is positional
  // first so the remote Commander parses it the same way local does.
  const argv: string[] = ["rig", "send", session, text];
  if (opts.verify) argv.push("--verify");
  if (opts.force) argv.push("--force");
  if (opts.waitForIdle !== undefined) argv.push("--wait-for-idle", opts.waitForIdle);
  if (opts.raw) argv.push("--raw");
  if (opts.dangerouslyInteract) argv.push("--dangerously-interact");
  if (opts.reason !== undefined) argv.push("--reason", opts.reason);
  if (opts.json) argv.push("--json");

  const result = await runner(host, argv);

  if (opts.json) {
    console.log(JSON.stringify({
      cross_host: { host: host.id, target: hostDisplayTarget(host) },
      result,
    }));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  console.log(`[via host=${host.id} (${hostDisplayTarget(host)})]`);
  if (result.ok) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return;
  }
  emitCrossHostFailure(host.id, hostDisplayTarget(host), result, opts.json);
}

function parseWaitForIdleMs(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.ceil(seconds * 1000);
}

function waitForIdleRequestOptions(waitForIdleMs: number | undefined): { timeoutMs: number } | undefined {
  if (waitForIdleMs === undefined) return undefined;
  return { timeoutMs: waitForIdleMs + WAIT_FOR_IDLE_REQUEST_OVERHEAD_MS };
}
