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
-- A related verdict is kept too, so a restart reads the card instead of
-- asking about it again. (The table above can only hold unrelated ones.)
CREATE TABLE IF NOT EXISTS related_listing_cards (
  url TEXT NOT NULL,
  role_goals_key TEXT NOT NULL,
  card_fingerprint TEXT NOT NULL,
  PRIMARY KEY (url, role_goals_key)
) WITHOUT ROWID;
`;

export function lookupSeenCards(
  sql: Statements,
  cards: readonly Pick<SeenListingCard, "url" | "cardFingerprint">[],
  roleGoalsKey: string,
): SeenListingCard[] {
  const find = sql(
    `SELECT 'unrelated' AS verdict FROM seen_listing_cards WHERE url = ?1 AND role_goals_key = ?2 AND card_fingerprint = ?3
    UNION ALL SELECT 'related' FROM related_listing_cards WHERE url = ?1 AND role_goals_key = ?2 AND card_fingerprint = ?3
    LIMIT 1`,
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
  const unrelated =
    sql(`INSERT INTO seen_listing_cards (url, role_goals_key, card_fingerprint, verdict) VALUES (?, ?, ?, 'unrelated')
    ON CONFLICT (url, role_goals_key) DO UPDATE SET card_fingerprint = excluded.card_fingerprint
    WHERE card_fingerprint <> excluded.card_fingerprint`);
  const related =
    sql(`INSERT INTO related_listing_cards (url, role_goals_key, card_fingerprint) VALUES (?, ?, ?)
    ON CONFLICT (url, role_goals_key) DO UPDATE SET card_fingerprint = excluded.card_fingerprint
    WHERE card_fingerprint <> excluded.card_fingerprint`);
  // One verdict per card: the latest replaces the other kind.
  const clear = {
    unrelated: sql(
      "DELETE FROM related_listing_cards WHERE url = ? AND role_goals_key = ?",
    ),
    related: sql(
      "DELETE FROM seen_listing_cards WHERE url = ? AND role_goals_key = ?",
    ),
  };
  for (const card of cards) {
    const url = normalizeUrl(card.url);
    clear[card.verdict].run(url, card.roleGoalsKey);
    (card.verdict === "related" ? related : unrelated).run(
      url,
      card.roleGoalsKey,
      card.cardFingerprint,
    );
  }
}
