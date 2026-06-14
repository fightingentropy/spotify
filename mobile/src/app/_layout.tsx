import "@/lib/logbox";
import "react-native-url-polyfill/auto";
import "@/audio/register";
import "../../global.css";

import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import * as SystemUI from "expo-system-ui";
import { AuthProvider } from "@/lib/auth";
import { AudioBootstrap } from "@/components/AudioBootstrap";
import { PlayerSheets } from "@/components/player/PlayerSheets";
import { initOfflineSync } from "@/store/offline";
import { colors } from "@/theme";

void SplashScreen.preventAutoHideAsync();

const headerOptions = {
  headerShown: true,
  headerStyle: { backgroundColor: colors.background },
  headerTintColor: colors.foreground,
  headerShadowVisible: false,
} as const;

export default function RootLayout() {
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(colors.background);
    void SplashScreen.hideAsync();
  }, []);

  // Replay the offline mutation outbox (likes/edits queued while offline) when the
  // app returns to the foreground; returns an AppState unsubscribe for cleanup.
  useEffect(() => initOfflineSync(), []);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <SafeAreaProvider>
        <AuthProvider>
          <AudioBootstrap />
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.background },
            }}
          >
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="signin" options={{ presentation: "modal" }} />
            <Stack.Screen name="register" options={{ presentation: "modal" }} />
            <Stack.Screen name="liked" options={{ ...headerOptions, title: "Liked Songs" }} />
            <Stack.Screen name="downloads" options={{ ...headerOptions, title: "Downloads" }} />
            <Stack.Screen name="radio" options={{ ...headerOptions, title: "Radio Stations" }} />
            <Stack.Screen name="podcasts" options={{ ...headerOptions, title: "Podcasts" }} />
            <Stack.Screen name="upload" options={{ ...headerOptions, title: "Upload" }} />
            <Stack.Screen name="settings" options={{ ...headerOptions, title: "Settings" }} />
            <Stack.Screen name="profile" options={{ ...headerOptions, title: "Profile" }} />
            <Stack.Screen name="playlist/[id]" options={{ ...headerOptions, title: "" }} />
          </Stack>
          <PlayerSheets />
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
