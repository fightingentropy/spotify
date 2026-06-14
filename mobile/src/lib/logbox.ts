import { LogBox } from "react-native";

// Imported FIRST in app/_layout (before @/audio/register) so the ignore list is in
// place before react-native-track-player initializes. RNTP's JS declares sleep-timer
// methods the iOS native module doesn't expose; this app drives the sleep timer from
// JS, so those bridge warnings are noise.
LogBox.ignoreLogs([
  /can not be found in the Objective-C definition of the TrackPlayerModule/,
  /sleepWhenActiveTrackReachesEnd|getSleepTimerProgress|setSleepTimer|clearSleepTimer/,
]);
