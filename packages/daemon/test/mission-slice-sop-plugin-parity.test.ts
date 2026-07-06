// OPR.0.4.4.23 (arch S2) — the bundled openrig-core plugin's copy of
// mission-slice-sop must be MECHANICALLY pinned to the canonical product
// skill source: hand-sync without a guard is banned. This is the
// scope-audit-copies pattern (byte-parity CI test) applied to the skill —
// the mirror-skills script covers specs → skills/_canonical, and this test
// covers specs → the bundled plugin. Any edit to one copy fails here until
// the other copy is refreshed (cp, byte-for-byte).

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

const CANONICAL_SOURCE = path.join(
  repoRoot,
  "packages/daemon/specs/agents/shared/skills/core/mission-slice-sop/SKILL.md",
);
const PLUGIN_COPY = path.join(
  repoRoot,
  "packages/daemon/assets/plugins/openrig-core/skills/mission-slice-sop/SKILL.md",
);

describe("OPR.0.4.4.23 mission-slice-sop plugin byte-parity (S2 drift guard)", () => {
  it("both copies exist", () => {
    expect(fs.existsSync(CANONICAL_SOURCE), `missing ${CANONICAL_SOURCE}`).toBe(true);
    expect(fs.existsSync(PLUGIN_COPY), `missing ${PLUGIN_COPY}`).toBe(true);
  });

  it("the bundled plugin copy is byte-identical to the canonical skill source", () => {
    const source = fs.readFileSync(CANONICAL_SOURCE);
    const plugin = fs.readFileSync(PLUGIN_COPY);
    expect(
      source.equals(plugin),
      "mission-slice-sop drifted between the canonical skill source and the bundled plugin — refresh the plugin copy byte-for-byte (cp source → plugin); hand-edited divergence is banned (OPR.0.4.4.23 S2)",
    ).toBe(true);
  });
});
