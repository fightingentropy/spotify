import { describe, expect, test } from "bun:test";

const homeScreen = await Bun.file(
  new URL("../src/app/(tabs)/index.tsx", import.meta.url),
).text();

describe("home content layout", () => {
  test("keeps YouTube Music shelves between listening history and Discover", () => {
    expect(homeScreen).not.toContain("Made for you");
    expect(homeScreen).toContain("/api/stats/home");
    const history = homeScreen.indexOf('<SectionTitle title="Continue listening"');
    const shelves = homeScreen.indexOf("youtubeHome.shelves.map");
    const discover = homeScreen.indexOf('<SectionTitle title="Discover" />');
    expect(history).toBeGreaterThan(-1);
    expect(history).toBeLessThan(shelves);
    expect(shelves).toBeLessThan(discover);
  });
});
