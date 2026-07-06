// OPR.0.4.4.15 — THE shared intra-P4 fan-out payload contract.
//
// ONE contract for the whole P4 packet (arch adjudication 2026-07-05,
// cross-PRD interface cell): slice 15's aggregated For-You attention feed
// AND slice 21's `rig ps --all-hosts` rollup both speak AggregatedPayload —
// items plus a per-host structured status array. Slice 15 defines this
// module (first lander, per the whichever-builds-first rule named in both
// PRDs); slice 21 IMPORTS it. Any change here is a CROSS-PRD contract
// change requiring re-review of BOTH slices — never driver discretion.

/** The local host's id literal in every P3/P4 payload (arch pin: defined
 *  ONCE here, imported everywhere, never retyped). Matches slice 11's
 *  topology aggregate literal. */
export const LOCAL_HOST_ID = "local";

/** CLOSED enum (arch pin A). `unsupported-transport` is R15-2's explicit
 *  class (an SSH-declared host is never a silently thinner payload);
 *  `auth-failed` is distinct from `unreachable` because the operator fix
 *  differs (rotate/set the bearer vs check the host). Extending this set =
 *  a cross-PRD contract change (slices 15 AND 21 re-review). */
export type PerHostStatusKind = "ok" | "unreachable" | "unsupported-transport" | "auth-failed";

export interface PerHostStatus {
  hostId: string;
  status: PerHostStatusKind;
  /** Honest failure detail, rendered muted next to the host chip/row. */
  error?: string;
  /** ADDITIVE OPTIONAL detail (arch adjudication): the shipped CLI
   *  FailedStep vocabulary when a transport-level step classified the
   *  failure. Never load-bearing — `status` is the contract. */
  failedStep?: string;
}

/** items + per-host status: EVERY subscribed host appears in `hosts` on
 *  EVERY payload — ok, unreachable, auth-failed, or unsupported-transport.
 *  Absence is a contract violation (omission-proof; never all-or-nothing,
 *  never silent thinning). */
export interface AggregatedPayload<T> {
  items: T[];
  hosts: PerHostStatus[];
}

/** Contract-level completeness predicate (arch pin B: asserted as near to
 *  the contract as tests allow): true iff every expected host id appears
 *  exactly once in the payload's hosts array. */
export function hostsCovered(payload: AggregatedPayload<unknown>, expectedHostIds: string[]): boolean {
  const seen = new Map<string, number>();
  for (const h of payload.hosts) seen.set(h.hostId, (seen.get(h.hostId) ?? 0) + 1);
  return expectedHostIds.every((id) => seen.get(id) === 1) && payload.hosts.length === expectedHostIds.length;
}
