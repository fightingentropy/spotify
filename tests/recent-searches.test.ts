import { expect, test } from "bun:test";
import { readRecentSearches, recentSearchesKey, rememberSearch } from "../packages/shared/src/recent-searches";

test("recent searches recover safely, dedupe matching queries, and stay bounded per account", () => {
  expect(readRecentSearches("broken")).toEqual([]);
  expect(readRecentSearches('[null, "  Blur  ", 5]')).toEqual(["Blur"]);
  expect(rememberSearch(["Beyoncé", "Blur"], "beyonce")).toEqual(["beyonce", "Blur"]);
  expect(rememberSearch(Array.from({ length: 8 }, (_, i) => `query ${i}`), "latest")).toHaveLength(8);
  expect(recentSearchesKey("one")).not.toBe(recentSearchesKey("two"));
});
