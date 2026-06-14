import { Platform } from "react-native";

// Registered at module load (imported first thing in app/_layout). On iOS the app
// uses the native dual-deck AudioEngine module (which owns its own lock-screen
// remote commands), so RNTP is not set up there and its playback service must NOT
// be registered. On Android/other, register the RNTP service before setupPlayer so
// remote commands route while the UI is backgrounded.
if (Platform.OS !== "ios") {
  const TrackPlayer = require("react-native-track-player").default;
  const { PlaybackService } = require("@/audio/service");
  TrackPlayer.registerPlaybackService(() => PlaybackService);
}
