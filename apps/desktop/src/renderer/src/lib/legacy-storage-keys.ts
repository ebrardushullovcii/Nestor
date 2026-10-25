// Newest first, so a key saved under Nordri wins over the UnEmployed one.
const LEGACY_PREFIXES = ["nordri.", "unemployed."] as const;
const CURRENT_PREFIX = "nestor.";

/**
 * Preferences saved before the Nestor rename (ADR 0052) use the "nordri."
 * prefix, and older ones the "unemployed." prefix and the "interview-helper"
 * module name (ADR 0040). Copy each one to its current key once, without
 * overwriting a value saved under the new name.
 */
export function migrateLegacyStorageKeys(storage: Storage): void {
  for (const legacyPrefix of LEGACY_PREFIXES) {
    const legacyKeys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(legacyPrefix)) legacyKeys.push(key);
    }

    for (const legacyKey of legacyKeys) {
      const key = `${CURRENT_PREFIX}${legacyKey.slice(legacyPrefix.length)}`.replace(
        "interview-helper",
        "live-assistant",
      );
      const value = storage.getItem(legacyKey);
      if (value !== null && storage.getItem(key) === null) {
        storage.setItem(key, value);
      }
      storage.removeItem(legacyKey);
    }
  }
}
