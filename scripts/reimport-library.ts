import { discoverMusicLibrary } from "../src/lib/local-library";
import { db } from "../src/lib/db";

const users = await db<{ id: string; email: string }>`
  SELECT "id", "email"
  FROM "User"
  WHERE "email" != 'library@waveform.local'
  ORDER BY "createdAt" ASC
  LIMIT 1
`;

const userId = users[0]?.id;
if (!userId) {
  console.error("No user found for import");
  process.exit(1);
}

console.log(`Importing library for ${users[0]?.email ?? userId}...`);
const started = Date.now();
const summary = await discoverMusicLibrary({
  userId,
  includeCoverFiles: true,
  includeLyricsFiles: true,
});

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
if (summary.mode === "organized" && summary.organized) {
  console.log(JSON.stringify({ elapsedSeconds: elapsed, ...summary.organized }, null, 2));
} else {
  console.log(JSON.stringify({ elapsedSeconds: elapsed, ...(summary.imported ?? {}) }, null, 2));
}

await db.end();
