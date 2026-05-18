import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// -- Shared types --

/**
 * Provenance block — attribution metadata for a bundle artifact. All fields
 * optional for backward compat; bundles without provenance install unchanged.
 * Captured by the bundle-assembler at create time; surfaced in inspect output
 * and audit-trail records. Not cryptographically signed at this stage.
 */
export interface BundleProvenance {
  /** ISO timestamp; mirrors root createdAt at create time. */
  createdAt?: string;
  /** os.hostname() of the host that ran rig bundle create. */
  sourceHost?: string;
  /** Canonical session name of the creator (e.g. velocity-driver@openrig-velocity). */
  authorSession?: string;
  /** ULID of the source rig, if creating from a live rig. */
  sourceRigId?: string;
  /** Name of the source rig, if creating from a live rig. */
  sourceRigName?: string;
  /** Daemon version at create time (e.g. 0.3.2). */
  daemonVersion?: string;
  /** CLI version at create time (e.g. 0.3.2). */
  cliVersion?: string;
  /** Operator-authored notes from the --notes flag on rig bundle create. */
  notes?: string;
}

const PROVENANCE_STRING_FIELDS = [
  "created_at",
  "source_host",
  "author_session",
  "source_rig_id",
  "source_rig_name",
  "daemon_version",
  "cli_version",
  "notes",
] as const;

/** Validate optional provenance block. Appends to errors if present-but-malformed. */
function validateProvenanceBlock(raw: unknown, errors: string[]): void {
  if (raw === undefined) return;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("provenance must be an object");
    return;
  }
  const p = raw as Record<string, unknown>;
  for (const field of PROVENANCE_STRING_FIELDS) {
    if (field in p && typeof p[field] !== "string") {
      errors.push(`provenance.${field} must be a string`);
    }
  }
}

/** Serialize a typed BundleProvenance to the snake_case YAML record shape. */
function provenanceToYamlRecord(p: BundleProvenance): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.createdAt !== undefined) out["created_at"] = p.createdAt;
  if (p.sourceHost !== undefined) out["source_host"] = p.sourceHost;
  if (p.authorSession !== undefined) out["author_session"] = p.authorSession;
  if (p.sourceRigId !== undefined) out["source_rig_id"] = p.sourceRigId;
  if (p.sourceRigName !== undefined) out["source_rig_name"] = p.sourceRigName;
  if (p.daemonVersion !== undefined) out["daemon_version"] = p.daemonVersion;
  if (p.cliVersion !== undefined) out["cli_version"] = p.cliVersion;
  if (p.notes !== undefined) out["notes"] = p.notes;
  return out;
}

/**
 * Normalize raw snake_case provenance (as parsed from YAML or received from
 * a request body) to typed camelCase BundleProvenance. Returns undefined when
 * absent or empty. Exported so both the v1 normalizer pipeline and the v2
 * inspect-route projection produce identical camelCase shapes — the
 * /api/bundles/inspect contract is one shape regardless of schema version.
 */
export function normalizeProvenanceBlock(raw: unknown): BundleProvenance | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const p = raw as Record<string, unknown>;
  const result: BundleProvenance = {};
  if (typeof p["created_at"] === "string") result.createdAt = p["created_at"];
  if (typeof p["source_host"] === "string") result.sourceHost = p["source_host"];
  if (typeof p["author_session"] === "string") result.authorSession = p["author_session"];
  if (typeof p["source_rig_id"] === "string") result.sourceRigId = p["source_rig_id"];
  if (typeof p["source_rig_name"] === "string") result.sourceRigName = p["source_rig_name"];
  if (typeof p["daemon_version"] === "string") result.daemonVersion = p["daemon_version"];
  if (typeof p["cli_version"] === "string") result.cliVersion = p["cli_version"];
  if (typeof p["notes"] === "string") result.notes = p["notes"];
  return Object.keys(result).length > 0 ? result : undefined;
}

// -- Pod-aware bundle types (AgentSpec reboot) --

export interface PodBundleAgentImportEntry {
  name: string;
  version: string;
  path: string;
  originalRef: string;
  hash: string;
}

export interface PodBundleAgentEntry {
  name: string;
  version: string;
  path: string;
  originalRef: string;
  hash: string;
  importEntries: PodBundleAgentImportEntry[];
}

export interface PodBundleManifest {
  schemaVersion: 2;
  name: string;
  version: string;
  createdAt: string;
  rigSpec: string;
  agents: PodBundleAgentEntry[];
  cultureFile?: string;
  integrity?: BundleIntegrity;
  provenance?: BundleProvenance;
}

export function validatePodBundleManifest(raw: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") return { valid: false, errors: ["manifest must be an object"] };
  const m = raw as Record<string, unknown>;

  if (m["schema_version"] !== 2) errors.push("schema_version must be 2");
  if (typeof m["name"] !== "string" || !m["name"]) errors.push("name is required");
  if (typeof m["version"] !== "string" || !m["version"]) errors.push("version is required");
  if (typeof m["created_at"] !== "string" || !m["created_at"]) errors.push("created_at is required");
  if (typeof m["rig_spec"] !== "string" || !m["rig_spec"]) errors.push("rig_spec path is required");
  else if (!isRelativeSafePath(m["rig_spec"] as string)) errors.push(`rig_spec path is not safe: '${m["rig_spec"]}'`);

  if (!Array.isArray(m["agents"])) {
    errors.push("agents must be an array");
  } else {
    for (let i = 0; i < m["agents"].length; i++) {
      const a = m["agents"][i] as Record<string, unknown>;
      if (typeof a["name"] !== "string" || !a["name"]) errors.push(`agents[${i}].name is required`);
      if (typeof a["path"] !== "string" || !a["path"]) errors.push(`agents[${i}].path is required`);
      else if (!isRelativeSafePath(a["path"] as string)) errors.push(`agents[${i}].path is not safe`);
      if (typeof a["hash"] !== "string" || !a["hash"]) errors.push(`agents[${i}].hash is required`);
    }
  }

  validateProvenanceBlock(m["provenance"], errors);

  return { valid: errors.length === 0, errors };
}

export function serializePodBundleManifest(manifest: PodBundleManifest): string {
  const doc: Record<string, unknown> = {
    schema_version: 2,
    name: manifest.name,
    version: manifest.version,
    created_at: manifest.createdAt,
    rig_spec: manifest.rigSpec,
    agents: manifest.agents.map((a) => ({
      name: a.name,
      version: a.version,
      path: a.path,
      original_ref: a.originalRef,
      hash: a.hash,
      import_entries: a.importEntries.map((ie) => ({
        name: ie.name,
        version: ie.version,
        path: ie.path,
        original_ref: ie.originalRef,
        hash: ie.hash,
      })),
    })),
  };
  if (manifest.cultureFile) doc["culture_file"] = manifest.cultureFile;
  if (manifest.integrity) doc["integrity"] = { algorithm: manifest.integrity.algorithm, files: manifest.integrity.files };
  if (manifest.provenance) doc["provenance"] = provenanceToYamlRecord(manifest.provenance);
  return stringifyYaml(doc);
}

export function parsePodBundleManifest(yaml: string): unknown {
  return parseYaml(yaml);
}

// -- Legacy bundle types (pre-reboot) --
// TODO: Remove when AS-T12 migrates all consumers

/** A package entry in the legacy bundle manifest */
export interface LegacyBundlePackageEntry {
  name: string;
  version: string;
  path: string;
  originalSource: string;
  /** All original source refs when deduped from multiple inputs */
  originalSources?: string[];
}

/** Integrity section with per-file checksums */
export interface BundleIntegrity {
  algorithm: "sha256";
  files: Record<string, string>;
}

/** The bundle.yaml manifest */
export interface LegacyBundleManifest {
  schemaVersion: number;
  name: string;
  version: string;
  createdAt: string;
  rigSpec: string;
  packages: LegacyBundlePackageEntry[];
  integrity?: BundleIntegrity;
  provenance?: BundleProvenance;
}

/** Validation options */
interface ValidateOptions {
  requireIntegrity?: boolean;
}

/**
 * Check if a path is a safe archive-relative path.
 * Rejects: absolute paths, ../ traversal, backslashes, dot segments (./, bare .),
 * empty segments (//), empty string.
 */
export function isRelativeSafePath(p: string): boolean {
  if (!p || p.length === 0) return false;
  if (p.startsWith("/")) return false;
  if (p.includes("\\")) return false;
  const segments = p.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

/** Validate a raw parsed bundle manifest */
export function validateLegacyBundleManifest(
  raw: unknown,
  opts?: ValidateOptions,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const requireIntegrity = opts?.requireIntegrity ?? true;

  if (!raw || typeof raw !== "object") {
    return { valid: false, errors: ["manifest must be an object"] };
  }

  const m = raw as Record<string, unknown>;

  if (m["schema_version"] !== 1) errors.push("schema_version must be 1");
  if (typeof m["name"] !== "string" || !m["name"]) errors.push("name is required");
  if (typeof m["version"] !== "string" || !m["version"]) errors.push("version is required");
  if (typeof m["created_at"] !== "string" || !m["created_at"]) errors.push("created_at is required");

  // rig_spec path
  if (typeof m["rig_spec"] !== "string" || !m["rig_spec"]) {
    errors.push("rig_spec path is required");
  } else if (!isRelativeSafePath(m["rig_spec"] as string)) {
    errors.push(`rig_spec path is not a safe relative path: '${m["rig_spec"]}'`);
  }

  // packages
  if (!Array.isArray(m["packages"]) || m["packages"].length === 0) {
    errors.push("packages must be a non-empty array");
  } else {
    for (let i = 0; i < m["packages"].length; i++) {
      const pkg = m["packages"][i] as Record<string, unknown>;
      if (typeof pkg["name"] !== "string" || !pkg["name"]) errors.push(`packages[${i}].name is required`);
      if (typeof pkg["version"] !== "string" || !pkg["version"]) errors.push(`packages[${i}].version is required`);
      if (typeof pkg["path"] !== "string" || !pkg["path"]) {
        errors.push(`packages[${i}].path is required`);
      } else if (!isRelativeSafePath(pkg["path"] as string)) {
        errors.push(`packages[${i}].path is not a safe relative path: '${pkg["path"]}'`);
      }
      if (typeof pkg["original_source"] !== "string" || !pkg["original_source"]) errors.push(`packages[${i}].original_source is required`);
    }
  }

  // integrity (optional unless requireIntegrity)
  // Integrity validation — always validate structure when present, require when flag set
  const hasIntegrity = m["integrity"] && typeof m["integrity"] === "object";
  if (requireIntegrity && !hasIntegrity) {
    errors.push("integrity section is required");
  }
  if (hasIntegrity) {
    const integrity = m["integrity"] as Record<string, unknown>;
    if (integrity["algorithm"] !== "sha256") errors.push("integrity.algorithm must be 'sha256'");
    if (!integrity["files"] || typeof integrity["files"] !== "object" || Object.keys(integrity["files"] as object).length === 0) {
      errors.push("integrity.files must be a non-empty object");
    } else {
      const files = integrity["files"] as Record<string, unknown>;
      for (const [key, value] of Object.entries(files)) {
        if (!isRelativeSafePath(key)) {
          errors.push(`integrity.files key is not a safe relative path: '${key}'`);
        }
        if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
          errors.push(`integrity.files['${key}'] must be a 64-char hex SHA-256 hash`);
        }
      }
    }
  }

  validateProvenanceBlock(m["provenance"], errors);

  return { valid: errors.length === 0, errors };
}

/** Parse bundle.yaml YAML string to unknown */
export function parseLegacyBundleManifest(yaml: string): unknown {
  return parseYaml(yaml);
}

/** Normalize raw parsed manifest to typed LegacyBundleManifest */
export function normalizeLegacyBundleManifest(raw: unknown): LegacyBundleManifest {
  const m = raw as Record<string, unknown>;
  const pkgs = (m["packages"] as Array<Record<string, unknown>>).map((p) => {
    const entry: LegacyBundlePackageEntry = {
      name: p["name"] as string,
      version: p["version"] as string,
      path: p["path"] as string,
      originalSource: (p["original_source"] as string) ?? "",
    };
    if (Array.isArray(p["original_sources"])) {
      entry.originalSources = p["original_sources"] as string[];
    }
    return entry;
  });

  const result: LegacyBundleManifest = {
    schemaVersion: (m["schema_version"] as number) ?? 1,
    name: m["name"] as string,
    version: m["version"] as string,
    createdAt: (m["created_at"] as string) ?? new Date().toISOString(),
    rigSpec: m["rig_spec"] as string,
    packages: pkgs,
  };

  if (m["integrity"] && typeof m["integrity"] === "object") {
    const integ = m["integrity"] as Record<string, unknown>;
    result.integrity = {
      algorithm: "sha256",
      files: (integ["files"] as Record<string, string>) ?? {},
    };
  }

  const provenance = normalizeProvenanceBlock(m["provenance"]);
  if (provenance) result.provenance = provenance;

  return result;
}

/** Serialize a LegacyBundleManifest to YAML */
export function serializeLegacyBundleManifest(manifest: LegacyBundleManifest): string {
  const doc: Record<string, unknown> = {
    schema_version: manifest.schemaVersion,
    name: manifest.name,
    version: manifest.version,
    created_at: manifest.createdAt,
    rig_spec: manifest.rigSpec,
    packages: manifest.packages.map((p) => ({
      name: p.name,
      version: p.version,
      path: p.path,
      original_source: p.originalSource,
      ...(p.originalSources && p.originalSources.length > 1 ? { original_sources: p.originalSources } : {}),
    })),
  };

  if (manifest.integrity) {
    doc["integrity"] = {
      algorithm: manifest.integrity.algorithm,
      files: manifest.integrity.files,
    };
  }

  if (manifest.provenance) doc["provenance"] = provenanceToYamlRecord(manifest.provenance);

  return stringifyYaml(doc);
}
