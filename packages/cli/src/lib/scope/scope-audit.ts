import * as YAML from "yaml";
import { isMissionDotId, isSliceDotId } from "./dot-id.js";

export type RailStatus = "present" | "missing" | "malformed" | "readme-only";
export type FindingSeverity = "high" | "medium" | "low" | "info";
export type FindingKind =
  | "missing_progress"
  | "registration_ghost"
  | "missing_id"
  | "id_convention_violation"
  | "orphan_progress"
  | "missing_mission_brief"
  | "malformed_mission_brief"
  | "missing_mission_notes"
  | "missing_proof";

export interface AuditFinding {
  kind: FindingKind;
  severity: FindingSeverity;
  path: string;
  message: string;
  remediation: string;
}

export interface ScopeAuditInput {
  id: string | null;
  path: string;
  readmeFrontmatterRaw: string | null;
  progressFileExists: boolean;
  readmeOnlyMarker: boolean;
  isActiveRelease: boolean;
  level: "mission" | "slice";
  missionBriefExists?: boolean;
  missionBriefPath?: string;
  missionBriefContent?: string | null;
  missionNotesExists?: boolean;
  missionNotesPath?: string;
  proofFileExists?: boolean;
  proofFilePath?: string;
  proofDirExists?: boolean;
  proofDirPath?: string;
  proofDirHasEntries?: boolean;
  hasProofPacket?: boolean;
  sliceStatus?: string | null;
}

export interface ScopeAuditResult {
  railStatus: RailStatus;
  findings: AuditFinding[];
  frontmatterError: string | null;
}

const MISSION_BRIEF_HEADERS = ["What & why", "Building", "Progress", "Proven", "Needs you", "Pointers"];

function childPath(parent: string, child: string): string {
  return parent.endsWith("/") ? `${parent}${child}` : `${parent}/${child}`;
}

function missionBriefFix(): string {
  return "Create/populate MISSION_BRIEF.md using the slice-16 schema: # <Mission name> — Brief, then ## What & why, ## Building, ## Progress, ## Proven, ## Needs you, ## Pointers.";
}

function missionBriefConforms(content: string): boolean {
  const lines = content.split(/\r?\n/);
  const title = lines.find((line) => /^#\s+/.test(line) && !/^##\s+/.test(line))?.trim() ?? "";
  if (!/^#\s+.+\s+—\s+Brief\s*$/.test(title)) return false;
  const h2s = lines
    .map((line) => /^##\s+(.+?)\s*$/.exec(line)?.[1]?.trim() ?? null)
    .filter((header): header is string => header !== null);
  if (h2s.length < MISSION_BRIEF_HEADERS.length) return false;
  return MISSION_BRIEF_HEADERS.every((header, idx) => h2s[idx] === header);
}

function parseStatusFromFrontmatter(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const parsed = YAML.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const status = (parsed as Record<string, unknown>).status;
      return typeof status === "string" ? status : null;
    }
  } catch {
    return null;
  }
  return null;
}

function statusRequiresProof(status: string | null | undefined): boolean {
  if (!status) return false;
  const normalized = status.toLowerCase().trim();
  return normalized.includes("done")
    || normalized.includes("ship")
    || normalized.includes("close")
    || normalized.includes("proven")
    || normalized.includes("promoted");
}

export function classifyScopeItem(input: ScopeAuditInput): ScopeAuditResult {
  const findings: AuditFinding[] = [];
  let frontmatterError: string | null = null;
  let railStatus: RailStatus;

  // Rail status
  if (input.readmeOnlyMarker) {
    railStatus = "readme-only";
  } else if (input.progressFileExists) {
    railStatus = "present";
  } else {
    railStatus = "missing";
    findings.push({
      kind: "missing_progress",
      severity: input.isActiveRelease ? "high" : "low",
      path: input.path,
      message: `${input.level} has no PROGRESS.md and no readme-only marker`,
      remediation: `Run: rig scope ${input.level} create (scaffolds PROGRESS.md) or add progress_rail: readme-only to README frontmatter`,
    });
  }

  // Frontmatter classification (strict parse, NOT parseYamlSafely)
  if (input.readmeFrontmatterRaw === null) {
    findings.push({
      kind: "missing_id",
      severity: input.isActiveRelease ? "high" : "low",
      path: input.path,
      message: `README has no frontmatter (no id can be extracted)`,
      remediation: "Add YAML frontmatter with an id: field to the README",
    });
  } else {
    let parsed: unknown = null;
    let parseError: string | null = null;
    try {
      parsed = YAML.parse(input.readmeFrontmatterRaw);
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }

    const hasIdLine = /^id\s*:/m.test(input.readmeFrontmatterRaw);

    if (parseError) {
      frontmatterError = parseError;
      railStatus = "malformed";
      if (hasIdLine) {
        findings.push({
          kind: "registration_ghost",
          severity: input.isActiveRelease ? "high" : "low",
          path: input.path,
          message: `README has an id: line but frontmatter fails to parse (registration ghost): ${parseError}`,
          remediation: "Fix the YAML frontmatter syntax error so the id can be read",
        });
      } else {
        findings.push({
          kind: "registration_ghost",
          severity: input.isActiveRelease ? "high" : "low",
          path: input.path,
          message: `README frontmatter fails to parse: ${parseError}`,
          remediation: "Fix the YAML frontmatter syntax error",
        });
      }
    } else {
      const fm = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
      const id = typeof fm.id === "string" ? fm.id : null;

      if (!id) {
        findings.push({
          kind: "missing_id",
          severity: input.isActiveRelease ? "high" : "low",
          path: input.path,
          message: `README frontmatter has no id field`,
          remediation: "Add an id: field to the README frontmatter matching the scope dot-ID convention",
        });
      } else {
        const validator = input.level === "mission" ? isMissionDotId : isSliceDotId;
        if (!validator(id)) {
          findings.push({
            kind: "id_convention_violation",
            severity: input.isActiveRelease ? "high" : "info",
            path: input.path,
            message: `id "${id}" does not match the ${input.level} dot-ID convention`,
            remediation: `Use a valid ${input.level} dot-ID format`,
          });
        }
      }
    }
  }

  if (input.level === "mission") {
    const briefPath = input.missionBriefPath ?? childPath(input.path, "MISSION_BRIEF.md");
    if (input.missionBriefExists === false) {
      findings.push({
        kind: "missing_mission_brief",
        severity: "medium",
        path: briefPath,
        message: "Mission has no root MISSION_BRIEF.md, so the Steering tab human-facing brief degrades.",
        remediation: missionBriefFix(),
      });
    } else if (
      input.missionBriefExists === true
      && typeof input.missionBriefContent === "string"
      && !missionBriefConforms(input.missionBriefContent)
    ) {
      findings.push({
        kind: "malformed_mission_brief",
        severity: "medium",
        path: briefPath,
        message: "MISSION_BRIEF.md does not match the canonical MISSION_BRIEF.md section order.",
        remediation: missionBriefFix(),
      });
    }

    if (input.missionNotesExists === false) {
      const notesPath = input.missionNotesPath ?? childPath(input.path, "MISSION_NOTES.md");
      findings.push({
        kind: "missing_mission_notes",
        severity: "low",
        path: notesPath,
        message: "Mission has no MISSION_NOTES.md continuity file.",
        remediation: "Add MISSION_NOTES.md at the mission root and populate it per the mission-notes convention.",
      });
    }
  }

  if (input.level === "slice") {
    const status = input.sliceStatus ?? parseStatusFromFrontmatter(input.readmeFrontmatterRaw);
    const hasProofPacket = input.hasProofPacket === true;
    const hasRootProof = input.proofFileExists === true
      && input.proofDirExists === true
      && input.proofDirHasEntries === true;
    const isProven = statusRequiresProof(status) || hasProofPacket;
    if (isProven && !hasRootProof) {
      const proofPath = input.proofFilePath ?? childPath(input.path, "PROOF.md");
      findings.push({
        kind: "missing_proof",
        severity: "medium",
        path: proofPath,
        message: "Slice is done/proven but does not have complete root PROOF.md plus populated proof/ artifacts.",
        remediation: "Add PROOF.md at the slice root and put verification artifacts under proof/ per the slice-closeout SOP.",
      });
    }
  }

  return { railStatus, findings, frontmatterError };
}
