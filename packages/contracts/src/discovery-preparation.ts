import type { DiscoveryListingFingerprints, JobPosting } from "./discovery";

/** Internal prepared facts travel with owned postings; JSON and IPC omit symbols. */
export const DISCOVERY_PREPARATION = Symbol.for("nestor.discoveryPreparation");

export type DiscoveryCompactKeys = {
  keys: readonly string[];
  priorities: readonly number[];
};
export type DiscoveryPreparedKeys = {
  local: DiscoveryCompactKeys;
  acrossSources: DiscoveryCompactKeys;
};
export type DiscoveryPreparedContent = {
  description: string;
  value: { digest: string; packed?: Uint8Array } | null;
};
export type DiscoveryPreparation = {
  content?: DiscoveryPreparedContent;
  identity?: DiscoveryPreparedKeys & {
    basis: readonly (string | boolean | null | undefined)[];
  };
  fingerprints?: {
    basis?: Readonly<Record<string, unknown>>;
    owner?: object;
    value: DiscoveryListingFingerprints;
  };
  normalizedPosting?: JobPosting;
};

export function readDiscoveryPreparation(
  value: object,
): DiscoveryPreparation | undefined {
  return (value as { [DISCOVERY_PREPARATION]?: DiscoveryPreparation })[
    DISCOVERY_PREPARATION
  ];
}

export function writeDiscoveryPreparation(
  value: object,
  preparation: Partial<DiscoveryPreparation>,
): boolean {
  if (
    !Object.isExtensible(value) ||
    Object.getOwnPropertyDescriptor(value, DISCOVERY_PREPARATION)
      ?.configurable === false
  )
    return false;
  Object.defineProperty(value, DISCOVERY_PREPARATION, {
    value: { ...readDiscoveryPreparation(value), ...preparation },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return true;
}

export const DISCOVERY_FINGERPRINT_FIELDS = [
  "applicationUrl",
  "title",
  "company",
  "location",
  "workMode",
  "applyPath",
  "easyApplyEligible",
  "postedAt",
  "postedAtText",
  "providerUpdatedAt",
  "salaryText",
  "employmentType",
  "department",
  "team",
  "detailQuality",
  "summary",
  "description",
  "keySkills",
  "responsibilities",
  "minimumQualifications",
  "preferredQualifications",
  "seniority",
  "screeningHints",
  "benefits",
] as const satisfies readonly (keyof JobPosting)[];

function equalInput(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object")
    return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length !== right.length
  )
    return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        equalInput(Reflect.get(left, key), Reflect.get(right, key)),
    )
  );
}

/** Stored fingerprints belong to the row; a changed copy must prepare new facts. */
export function readPreparedDiscoveryFingerprints(
  posting: object,
): DiscoveryListingFingerprints | null {
  const prepared = readDiscoveryPreparation(posting)?.fingerprints;
  if (!prepared) return null;
  if (prepared.owner === posting) return prepared.value;
  const source = prepared.basis ?? prepared.owner;
  return source &&
    DISCOVERY_FINGERPRINT_FIELDS.every((field) =>
      equalInput(Reflect.get(source, field), Reflect.get(posting, field)),
    )
    ? prepared.value
    : null;
}
