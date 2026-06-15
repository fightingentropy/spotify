import { Image } from "expo-image";

import { clearApiDataCache } from "@/lib/api";

// "Clear cache" entry point: drops every read-through cache layer so the app
// re-pulls everything fresh from the server. Wipes the API data caches (in-memory
// + persisted MMKV snapshots) and the cover-art image caches (memory + disk).
//
// Deliberately leaves intact: offline downloads (SQLite + FileSystem), the auth
// session, and user preferences/player/likes state. Those are not part of the
// server read-through cache and clearing them would log the user out or delete
// their music.
export async function clearAppCache(): Promise<void> {
  await clearApiDataCache();
  await Promise.allSettled([Image.clearMemoryCache(), Image.clearDiskCache()]);
}
