export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { syncMusicLibraryOnStartup } = await import("@/lib/music-sync");
    syncMusicLibraryOnStartup();
  }
}
