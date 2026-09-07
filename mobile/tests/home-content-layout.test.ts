import { describe, expect, test } from "bun:test";

const homeScreen = await Bun.file(
  new URL("../src/app/(tabs)/index.tsx", import.meta.url),
).text();

describe("home content layout", () => {
  test("keeps generated mixes after the listening shortcuts and history", () => {
    expect(homeScreen).toContain('<SectionTitle title="Made for you" />');
    expect(homeScreen).toContain("MADE_FOR_YOU_DEFINITIONS.map");
    expect(homeScreen).toContain('pathname: "/made-for-you/[kind]"');
    expect(homeScreen).toContain('<SectionTitle title="Discover" />');
    expect(homeScreen).toContain("Continue listening");
    expect(homeScreen).toContain("/api/stats/home");
    expect(homeScreen.indexOf('<SectionTitle title="Continue listening"')).toBeLessThan(homeScreen.indexOf('<SectionTitle title="Made for you"'));
  });
});
