// Geographic containment, not work authorization or a fit scorer. Only used
// to demote an incompatible regional claim; membership never grants a fit.
// Unicode CLDR 49, Unicode License V3, Copyright © 1991–2026 Unicode, Inc.
// SPDX-License-Identifier: Unicode-3.0
// https://www.unicode.org/license.txt
// https://github.com/unicode-org/cldr-json/blob/49.0.0/cldr-json/cldr-core/supplemental/territoryContainment.json
const codes = (value: string) => new Set(value.split(" "));
const europe = codes(
  "AD AL AT AX BA BE BG BY CH CQ CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA VA XK",
);
const americas = codes(
  "AG AI AR AW BB BL BM BO BQ BR BS BV BZ CA CL CO CR CU CW DM DO EC FK GD GF GL GP GS GT GY HN HT JM KN KY LC MF MQ MS MX NI PA PE PM PR PY SR SV SX TC TT US UY VC VE VG VI",
);
const asia = codes(
  "AE AF AM AZ BD BH BN BT CN CY GE HK ID IL IN IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE",
);
const africa = codes(
  "AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EA EG EH ER ET GA GH GM GN GQ GW IC IO KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RE RW SC SD SH SL SN SO SS ST SZ TD TF TG TN TZ UG YT ZA ZM ZW",
);
const oceania = codes(
  "AC AQ AS AU CC CK CP CX DG FJ FM GU HM KI MH MP NC NF NR NU NZ PF PG PN PW SB TA TK TO TV UM VU WF WS",
);
const eu = codes(
  "AT BE BG CY CZ DE DK EE ES FI FR GR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK",
);
const regions: Record<string, ReadonlySet<string>> = {
  europe,
  european: europe,
  americas,
  asia,
  africa,
  oceania,
  eu,
  "european union": eu,
  eea: new Set([...eu, "IS", "LI", "NO"]),
  "north america": codes(
    "AG AI AW BB BL BM BQ BS BZ CA CR CU CW DM DO GD GL GP GT HN HT JM KN KY LC MF MQ MS MX NI PA PM PR SV SX TC TT US VC VG VI",
  ),
  "south america": codes("AR BO BR BV CL CO EC FK GF GS GY PE PY SR UY VE"),
  latam: codes(
    "AG AI AR AW BB BL BO BQ BR BS BV BZ CL CO CR CU CW DM DO EC FK GD GF GP GS GT GY HN HT JM KN KY LC MF MQ MS MX NI PA PE PR PY SR SV SX TC TT UY VC VE VG VI",
  ),
  // Business regions have variable boundaries. These broad supersets only
  // reject clear outsiders; the model must still establish actual inclusion.
  apac: new Set([...asia, ...oceania]),
  emea: new Set([
    ...europe,
    ...africa,
    ...codes("AE AM AZ BH CY GE IL IQ JO KW LB OM PS QA SA SY TR YE"),
  ]),
};
regions["european economic area"] = regions.eea!;
regions["latin america"] = regions.latam!;
const europeBoundary = codes("AM AZ CY GE KZ TR");

/** A complete, recognized regional scope only. Unparsed qualifiers defer to AI. */
export function fitRegionContains(
  scope: string,
  country: string,
): boolean | null {
  const parts = scope
    .normalize("NFKC")
    .toLowerCase()
    .replace(
      /\b(?:work|working|remotely|remote|fully|from|within|throughout|based|in|only|any|country|countries)\b/gu,
      " ",
    )
    .split(/[,;/|()–—-]|\b(?:or|and)\b/u)
    .map((part) =>
      part
        .replace(/\s+/gu, " ")
        .replace(/[.!]+$/u, "")
        .trim(),
    )
    .filter(Boolean);
  if (!parts.length || parts.some((part) => !Object.hasOwn(regions, part)))
    return null;
  if (parts.some((part) => regions[part]?.has(country))) return true;
  if (
    parts.some(
      (part) =>
        (part === "europe" || part === "european") &&
        europeBoundary.has(country),
    )
  )
    return null;
  return false;
}
