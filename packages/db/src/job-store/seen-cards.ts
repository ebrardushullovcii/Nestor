import type { SeenListingCard } from "@nestor/contracts";
import { normalizeUrl } from "./found-jobs";
import type { Statements } from "./statements";

export const SEEN_CARDS_SCHEMA = `
CREATE TABLE IF NOT EXISTS seen_listing_cards (
  url TEXT NOT NULL,
  role_goals_key TEXT NOT NULL,
  card_fingerprint TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict = 'unrelated'),
  PRIMARY KEY (url, role_goals_key)
) WITHOUT ROWID;
`;

export function lookupSeenCards(
  sql: Statements,
  cards: readonly Pick<SeenListingCard, "url" | "cardFingerprint">[],
  roleGoalsKey: string,
): SeenListingCard[] {
  const find = sql(
    "SELECT verdict FROM seen_listing_cards WHERE url = ? AND role_goals_key = ? AND card_fingerprint = ?",
  );
  return cards.flatMap((card) => {
    const row = find.get(
      normalizeUrl(card.url),
      roleGoalsKey,
      card.cardFingerprint,
    ) as { verdict: SeenListingCard["verdict"] } | undefined;
    return row ? [{ ...card, roleGoalsKey, verdict: row.verdict }] : [];
  });
}

export function rememberSeenCards(
  sql: Statements,
  cards: readonly SeenListingCard[],
): void {
  const save =
    sql(`INSERT INTO seen_listing_cards (url, role_goals_key, card_fingerprint, verdict) VALUES (?, ?, ?, ?)
    ON CONFLICT (url, role_goals_key) DO UPDATE SET card_fingerprint = excluded.card_fingerprint, verdict = excluded.verdict
    WHERE card_fingerprint <> excluded.card_fingerprint OR verdict <> excluded.verdict`);
  for (const card of cards)
    save.run(
      normalizeUrl(card.url),
      card.roleGoalsKey,
      card.cardFingerprint,
      card.verdict,
    );
}
