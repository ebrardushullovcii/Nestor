import { describe, expect, it } from "vitest";
import {
  collapseRepeatedLocationTokens,
  isTruncatedLocationFragment,
  looksLikePlaceValue,
  splitListingLocations,
} from "./listing-field-shapes";

describe("looksLikePlaceValue", () => {
  it("recognises a country, a city-region pair and a work mode as places", () => {
    expect(looksLikePlaceValue("United States")).toBe(true);
    expect(looksLikePlaceValue("Chicago, IL")).toBe(true);
    expect(looksLikePlaceValue("Remote")).toBe(true);
    expect(looksLikePlaceValue("Austin, TX 78701")).toBe(true);
  });

  it("leaves an ordinary employer name alone", () => {
    expect(looksLikePlaceValue("Garner Health")).toBe(false);
    expect(looksLikePlaceValue("Rose, Klein & Marias")).toBe(false);
    expect(looksLikePlaceValue("Transportation Partners & Logistics")).toBe(
      false,
    );
  });

  it.each(["Austin, TX", "Toronto, ON", "Berlin, Germany"])(
    "requires a real region signal in %s",
    (place) => {
      expect(looksLikePlaceValue(place)).toBe(true);
    },
  );
});

describe("isTruncatedLocationFragment", () => {
  it("rejects a value cut off after a preposition", () => {
    expect(isTruncatedLocationFragment("Security Remote in")).toBe(true);
    expect(isTruncatedLocationFragment("Remote in the")).toBe(true);
  });

  it("accepts a whole place", () => {
    expect(isTruncatedLocationFragment("Chicago, IL")).toBe(false);
    expect(isTruncatedLocationFragment("Toronto, ON")).toBe(false);
    expect(isTruncatedLocationFragment("Indianapolis, IN")).toBe(false);
    expect(isTruncatedLocationFragment("Portland, OR")).toBe(false);
    expect(isTruncatedLocationFragment("Remote")).toBe(false);
  });
});

describe("splitListingLocations", () => {
  it("counts 'City, ST' as one place, not two", () => {
    expect(splitListingLocations("Chicago, IL")).toEqual(["Chicago, IL"]);
  });

  it("splits on an explicit list separator", () => {
    expect(splitListingLocations("Chicago, IL / Austin, TX")).toEqual([
      "Chicago, IL",
      "Austin, TX",
    ]);
    expect(splitListingLocations("Remote or New York, NY")).toEqual([
      "Remote",
      "New York, NY",
    ]);
  });
});

describe("collapseRepeatedLocationTokens", () => {
  it("states one place once", () => {
    expect(collapseRepeatedLocationTokens("Anywhere, Anywhere, Anywhere")).toBe(
      "Anywhere",
    );
  });

  it("keeps a genuine city and region pair", () => {
    expect(collapseRepeatedLocationTokens("Philadelphia, PA")).toBe(
      "Philadelphia, PA",
    );
  });
});
