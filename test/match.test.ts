import { describe, expect, it } from "vitest";
import {
  commentTriggers,
  extractEmail,
  hasExcludedWord,
  matchesAnyKeyword,
  matchesKeyword,
} from "../src/engine/match";

describe("whole-word keyword matching (Acceptance: 'ai' fires on 'this ai' not 'fair')", () => {
  it("matches the keyword as a standalone word, case-insensitively", () => {
    expect(matchesKeyword("I like this ai", "ai")).toBe(true);
    expect(matchesKeyword("AI rocks!", "ai")).toBe(true);
    expect(matchesKeyword("love ai!", "ai")).toBe(true);
    expect(matchesKeyword("LINK please", "link")).toBe(true);
  });

  it("does NOT match the keyword as a substring inside another word", () => {
    expect(matchesKeyword("that's not fair", "ai")).toBe(false);
    expect(matchesKeyword("rain is coming", "ai")).toBe(false);
    expect(matchesKeyword("she said hi", "ai")).toBe(false);
  });

  it("treats emoji/punctuation adjacent to the word as boundaries", () => {
    expect(matchesKeyword("ai🔥", "ai")).toBe(true);
    expect(matchesKeyword("(ai)", "ai")).toBe(true);
    expect(matchesKeyword("...LINK...", "link")).toBe(true);
  });

  it("escapes regex-special characters so the dot is literal, not a wildcard", () => {
    expect(matchesKeyword("I use node.js daily", "node.js")).toBe(true);
    expect(matchesKeyword("nodexjs is not a thing", "node.js")).toBe(false); // '.' must not act as wildcard
  });

  it("matchesAnyKeyword returns true if any keyword hits", () => {
    expect(matchesAnyKeyword("send me the GUIDE", ["LINK", "GUIDE"])).toBe(true);
    expect(matchesAnyKeyword("nothing here", ["LINK", "GUIDE"])).toBe(false);
  });

  it("ignores case on accented/non-ASCII words too (plain \\b is ASCII-only and misses these)", () => {
    expect(matchesKeyword("I love CAFÉ today", "café")).toBe(true);
    expect(matchesKeyword("nos vemos MAÑANA", "mañana")).toBe(true);
    expect(matchesKeyword("Ich hätte gern ÜBER alles", "über")).toBe(true);
  });
});

describe("forgiving trigger match (how people really type keywords)", () => {
  it("accepts a keyword typed with a space or hyphen", () => {
    expect(matchesAnyKeyword("Tik tok", ["tiktok"])).toBe(true);
    expect(matchesAnyKeyword("tik-tok please", ["tiktok"])).toBe(true);
    expect(matchesAnyKeyword("tier1", ["tier 1"])).toBe(true);
  });
  it("accepts a single typo on longer keywords", () => {
    expect(matchesAnyKeyword("Tiltok", ["tiktok"])).toBe(true);
    expect(matchesAnyKeyword("tiktoks", ["tiktok"])).toBe(true);
  });
  it("stays strict for short keywords, substrings and unrelated words", () => {
    expect(matchesAnyKeyword("that's not fair", ["ai"])).toBe(false);
    expect(matchesAnyKeyword("blinking lights", ["link"])).toBe(false);
    expect(matchesAnyKeyword("nice video bro", ["tiktok"])).toBe(false);
    expect(matchesAnyKeyword("nodexjs is not a thing", ["node.js"])).toBe(false);
  });
});

describe("exclude words + trigger composition", () => {
  it("an excluded word cancels the trigger (same whole-word rule)", () => {
    expect(hasExcludedWord("this is a scam", ["scam"])).toBe(true);
    expect(hasExcludedWord("scampi for dinner", ["scam"])).toBe(false); // substring must not fire
    expect(commentTriggers("LINK but scam", ["LINK"], ["scam"])).toBe(false);
    expect(commentTriggers("LINK please", ["LINK"], ["scam"])).toBe(true);
  });
});

describe("email extraction (chip fallback)", () => {
  it("accepts a bare email", () => {
    expect(extractEmail("ryan@example.com")).toBe("ryan@example.com");
  });
  it("extracts an email embedded in a longer reply", () => {
    expect(extractEmail("sure, it's me@site.co thanks")).toBe("me@site.co");
  });
  it("rejects non-emails", () => {
    expect(extractEmail("no email here")).toBeNull();
    expect(extractEmail(undefined)).toBeNull();
  });
});
