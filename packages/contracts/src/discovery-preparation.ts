import type { DiscoveryListingFingerprints, JobPosting } from "./discovery";
import type { extractSalaryRangeFromListingBody } from "./listing-salary-evidence";

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
/** Search owns these opaque keys and the exact proof behind a content alias. */
export type DiscoverySavedJobIdentity = DiscoveryPreparedKeys & {
  version: 1;
  content: { digest: string; packed: Uint8Array } | null;
};
export type DiscoverySavedJobFingerprints = DiscoveryListingFingerprints & {
  identity?: DiscoverySavedJobIdentity;
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
  savedIdentity?: {
    basis?: Readonly<Record<string, unknown>>;
    owner?: object;
    value: DiscoverySavedJobIdentity;
  };
  normalizedPosting?: JobPosting | undefined;
  normalizedPostingSource?: JobPosting | undefined;
  bodySalaryRange?: ReturnType<typeof extractSalaryRangeFromListingBody>;
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
  const previous = readDiscoveryPreparation(value);
  const next = { ...previous, ...preparation };
  const beforeBody =
    previous?.content?.description ??
    previous?.fingerprints?.basis?.description;
  if (
    !Object.hasOwn(preparation, "bodySalaryRange") &&
    ((preparation.content && preparation.content.description !== beforeBody) ||
      (preparation.fingerprints?.basis &&
        preparation.fingerprints.basis.description !== beforeBody) ||
      (preparation.fingerprints?.owner &&
        preparation.fingerprints.owner !== previous?.fingerprints?.owner))
  )
    delete next.bodySalaryRange;
  Object.defineProperty(value, DISCOVERY_PREPARATION, {
    value: next,
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

const SAVED_IDENTITY_FIELDS = [
  "source",
  "sourceJobId",
  "canonicalUrl",
  "applicationUrl",
  "providerKey",
  "providerBoardToken",
  "providerIdentifier",
  "title",
  "seniority",
  "company",
  "location",
  "description",
  "postedAt",
  "postedAtText",
] as const;

/** Capture only identity inputs, never provenance evidence or a second body copy. */
export function captureDiscoverySavedIdentityBasis(
  job: object,
): Readonly<Record<string, unknown>> {
  const canonicalUrl: unknown = Reflect.get(job, "canonicalUrl");
  const provenance: unknown = Reflect.get(job, "provenance");
  return {
    ...Object.fromEntries(
      SAVED_IDENTITY_FIELDS.map((field) => [field, Reflect.get(job, field)]),
    ),
    alternateListingUrls: Array.isArray(provenance)
      ? provenance.flatMap((entry: unknown) => {
          if (!entry || typeof entry !== "object") return [];
          const url: unknown = Reflect.get(entry, "listingUrl");
          return typeof url === "string" && url && url !== canonicalUrl
            ? [url]
            : [];
        })
      : [],
  };
}

/** Only a trusted frozen owner avoids checking the captured identity inputs. */
export function readPreparedSavedJobIdentity(
  job: object,
): DiscoverySavedJobIdentity | null {
  const prepared = readDiscoveryPreparation(job)?.savedIdentity;
  if (!prepared || (prepared.owner && !Object.isFrozen(prepared.owner)))
    return null;
  if (prepared.owner === job) return prepared.value;
  const basis =
    prepared.basis ??
    (prepared.owner && captureDiscoverySavedIdentityBasis(prepared.owner));
  return basis && equalInput(basis, captureDiscoverySavedIdentityBasis(job))
    ? prepared.value
    : null;
}

/** Stored fingerprints belong to the row; a changed copy must prepare new facts. */
export function readPreparedDiscoveryFingerprints(
  posting: object,
): DiscoveryListingFingerprints | null {
  const prepared = readDiscoveryPreparation(posting)?.fingerprints;
  if (!prepared) return null;
  if (prepared.owner && !Object.isFrozen(prepared.owner)) return null;
  if (prepared.owner === posting) return prepared.value;
  const source = prepared.basis ?? prepared.owner;
  return source &&
    DISCOVERY_FINGERPRINT_FIELDS.every((field) =>
      equalInput(Reflect.get(source, field), Reflect.get(posting, field)),
    )
    ? prepared.value
    : null;
}

/** The existing body salary parser's result, including a known absent range. */
export function readPreparedBodySalaryRange(
  posting: object,
): DiscoveryPreparation["bodySalaryRange"] {
  const prepared = readDiscoveryPreparation(posting);
  if (!prepared || !Object.hasOwn(prepared, "bodySalaryRange"))
    return undefined;
  const owner = prepared.fingerprints?.owner;
  if (owner === posting && Object.isFrozen(posting))
    return prepared.bodySalaryRange;
  const description: unknown = Reflect.get(posting, "description");
  return typeof description === "string" &&
    (prepared.content?.description === description ||
      prepared.fingerprints?.basis?.description === description ||
      (owner &&
        Object.isFrozen(owner) &&
        Reflect.get(owner, "description") === description))
    ? prepared.bodySalaryRange
    : undefined;
}
