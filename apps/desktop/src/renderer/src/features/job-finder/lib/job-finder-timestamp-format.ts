/**
 * One formatter for every date-and-time a search plan prints.
 *
 * Two cards on the Search plans screen showed the same kind of fact in two
 * shapes — "succeeded · Sep 12, 5:41 AM CDT" on a plan that had saved a time
 * zone, and "succeeded · Sep 12, 12:42 PM" on a plan that had not — so the
 * reader had no way to tell whether the two times were on the same clock.
 *
 * Historical instants are rendered on the device clock. A plan's saved zone
 * governs when its schedule fires; it does not reinterpret past events.
 */

/** The device's own zone, used whenever a plan has not saved one. */
export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function isSupportedTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Formats an instant for a plan card. `timeZone` is the zone the plan saved,
 * if any; an empty or unrecognised value falls back to the device's zone
 * rather than throwing or printing nothing.
 *
 * Returns `null` for a missing or unparsable timestamp so callers decide what
 * to say instead of printing a fabricated time.
 */
export function formatPlanTimestamp(
  iso: string | null | undefined,
  timeZone?: string | null,
  options?: { includeZoneName?: boolean },
): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  const saved = timeZone?.trim() ?? "";
  const zone =
    saved.length > 0 && isSupportedTimeZone(saved) ? saved : deviceTimeZone();

  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZone: zone,
    ...(options?.includeZoneName === false ? {} : { timeZoneName: "short" }),
  }).format(new Date(parsed));
}

export function resolvePlanTimeZone(timeZone?: string | null): string {
  const saved = timeZone?.trim() ?? "";
  return saved.length > 0 && isSupportedTimeZone(saved)
    ? saved
    : deviceTimeZone();
}

const CITY_TIME_ZONES: Readonly<Record<string, string>> = {
  chicago: "America/Chicago",
  "los angeles": "America/Los_Angeles",
  "new york": "America/New_York",
  phoenix: "America/Phoenix",
  philadelphia: "America/New_York",
  houston: "America/Chicago",
  dallas: "America/Chicago",
  denver: "America/Denver",
  seattle: "America/Los_Angeles",
  toronto: "America/Toronto",
  vancouver: "America/Vancouver",
  montreal: "America/Toronto",
  lisbon: "Europe/Lisbon",
  porto: "Europe/Lisbon",
  budapest: "Europe/Budapest",
  london: "Europe/London",
  pristina: "Europe/Belgrade",
  prishtina: "Europe/Belgrade",
};

// States with more than one zone use the zone containing their most populous
// city. That gives a predictable default while leaving the editor free to
// select a different IANA zone for a particular address.
const US_STATE_TIME_ZONES: Readonly<Record<string, string>> = {
  alabama: "America/Chicago", alaska: "America/Anchorage",
  arizona: "America/Phoenix", arkansas: "America/Chicago",
  california: "America/Los_Angeles", colorado: "America/Denver",
  connecticut: "America/New_York", delaware: "America/New_York",
  florida: "America/New_York", georgia: "America/New_York",
  hawaii: "Pacific/Honolulu", idaho: "America/Boise",
  illinois: "America/Chicago", indiana: "America/Indiana/Indianapolis",
  iowa: "America/Chicago", kansas: "America/Chicago",
  kentucky: "America/New_York", louisiana: "America/Chicago",
  maine: "America/New_York", maryland: "America/New_York",
  massachusetts: "America/New_York", michigan: "America/Detroit",
  minnesota: "America/Chicago", mississippi: "America/Chicago",
  missouri: "America/Chicago", montana: "America/Denver",
  nebraska: "America/Chicago", nevada: "America/Los_Angeles",
  "new hampshire": "America/New_York", "new jersey": "America/New_York",
  "new mexico": "America/Denver", "new york": "America/New_York",
  "north carolina": "America/New_York", "north dakota": "America/Chicago",
  ohio: "America/New_York", oklahoma: "America/Chicago",
  oregon: "America/Los_Angeles", pennsylvania: "America/New_York",
  "rhode island": "America/New_York", "south carolina": "America/New_York",
  "south dakota": "America/Chicago", tennessee: "America/Chicago",
  texas: "America/Chicago", utah: "America/Denver",
  vermont: "America/New_York", virginia: "America/New_York",
  washington: "America/Los_Angeles", "west virginia": "America/New_York",
  wisconsin: "America/Chicago", wyoming: "America/Denver",
  "district of columbia": "America/New_York",
};

const CANADA_PROVINCE_TIME_ZONES: Readonly<Record<string, string>> = {
  alberta: "America/Edmonton", "british columbia": "America/Vancouver",
  manitoba: "America/Winnipeg", "new brunswick": "America/Moncton",
  "newfoundland and labrador": "America/St_Johns",
  "nova scotia": "America/Halifax", ontario: "America/Toronto",
  "prince edward island": "America/Halifax", quebec: "America/Toronto",
  saskatchewan: "America/Regina", yukon: "America/Whitehorse",
  nunavut: "America/Iqaluit", "northwest territories": "America/Yellowknife",
};

const COUNTRY_TIME_ZONES: Readonly<Record<string, string>> = {
  portugal: "Europe/Lisbon", hungary: "Europe/Budapest",
  kosovo: "Europe/Belgrade", "united kingdom": "Europe/London",
  ireland: "Europe/Dublin", france: "Europe/Paris", germany: "Europe/Berlin",
  spain: "Europe/Madrid", italy: "Europe/Rome", netherlands: "Europe/Amsterdam",
};

function normalizedLocationPart(value: string | null | undefined): string {
  return value?.trim().toLocaleLowerCase("en-US") ?? "";
}

function lookupLocation(
  table: Readonly<Record<string, string>>,
  value: string,
): string | undefined {
  return (
    table[value] ??
    Object.entries(table).find(([name]) =>
      new RegExp(`(?:^|[,/\\s])${name.replaceAll(" ", "\\s+")}(?:$|[,/\\s])`, "u").test(
        value,
      ),
    )?.[1]
  );
}

/** Best-effort default from profile location, with an explicit device fallback. */
export function inferProfileTimeZone(input: {
  timeZone?: string | null;
  currentLocation?: string | null;
  currentRegion?: string | null;
  currentCountry?: string | null;
}): { timeZone: string; source: "profile" | "device" } {
  if (input.timeZone?.trim() && isSupportedTimeZone(input.timeZone.trim()))
    return { timeZone: input.timeZone.trim(), source: "profile" };
  const city = normalizedLocationPart(input.currentLocation);
  const region = normalizedLocationPart(input.currentRegion);
  const country = normalizedLocationPart(input.currentCountry);
  const inferred =
    lookupLocation(CITY_TIME_ZONES, city) ??
    lookupLocation(US_STATE_TIME_ZONES, region) ??
    lookupLocation(CANADA_PROVINCE_TIME_ZONES, region) ??
    lookupLocation(COUNTRY_TIME_ZONES, country);
  return inferred
    ? { timeZone: inferred, source: "profile" }
    : { timeZone: deviceTimeZone(), source: "device" };
}

/**
 * Formats a historical event on the device clock. Search-plan zones describe
 * when a schedule should fire; they never reinterpret an event that already
 * happened.
 */
export function formatDeviceTimestamp(
  iso: string | null | undefined,
): string | null {
  return formatPlanTimestamp(iso, deviceTimeZone());
}
