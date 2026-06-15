import { Tabs } from "expo-router";

// The visible tab bar is mounted globally in the root layout (so it persists on pushed
// stack screens too), so the navigator itself renders no built-in bar.
export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }} tabBar={() => null}>
      <Tabs.Screen name="index" options={{ title: "Home" }} />
      <Tabs.Screen name="search" options={{ title: "Search" }} />
      <Tabs.Screen name="library" options={{ title: "Your Library" }} />
    </Tabs>
  );
}
