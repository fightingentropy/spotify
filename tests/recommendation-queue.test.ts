import { expect, test } from "bun:test";
import { selectRecommendations } from "../src/lib/recommendations";

const track = (id: string, title: string, artist = "Artist") => ({ id, title, artist });

test("a cached candidate pool obeys each request's latest exclusions", () => {
  const pool = [track("seed", "Selected"), track("heard", "Already heard"), track("next", "Next", "Other")];
  expect(selectRecommendations(pool, [pool[0]], new Set(), 12).map(t => t.id)).toEqual(["heard", "next"]);
  expect(selectRecommendations(pool, [pool[0], { title: "Already Heard!", artist: "ARTIST" }], new Set(), 12).map(t => t.id)).toEqual(["next"]);
  expect(selectRecommendations(pool, [pool[0]], new Set(["heard", "next"]), 12)).toEqual([]);
  expect(pool).toHaveLength(3);
});

test("alternate release ids, cover versions, and duplicate rows cannot repeat a recording", () => {
  const pool = [track("1", "Hello", "Adele"), track("2", "Hello!", "ADELE"), track("3", "Hello (Karaoke Version)", "Karaoke Crew"), track("1", "Hello", "Adele")];
  expect(selectRecommendations(pool, [], new Set(), 12).map(t => t.id)).toEqual(["1"]);
  expect(selectRecommendations(pool, [track("old-release", "hello", "Adele")], new Set(), 12)).toEqual([]);
});

test("related artists are interleaved and one artist cannot fill the mix", () => {
  const pool = [1, 2, 3, 4, 5].map(n => track(`a${n}`, `Song ${n}`, "First"))
    .concat([1, 2, 3].map(n => track(`b${n}`, `Other ${n}`, "Second")));
  const selected = selectRecommendations(pool, [], new Set(), 12);
  expect(selected.map(t => t.artist)).toEqual(["First", "Second", "First", "Second", "First", "Second"]);
  expect(selectRecommendations(pool, [], new Set(), 2)).toHaveLength(2);
});
