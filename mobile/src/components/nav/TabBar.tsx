import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { BlurView } from "expo-blur";
import { PressableScale } from "@/components/ui/PressableScale";
import { MiniPlayer } from "@/components/player/MiniPlayer";
import { HomeTabIcon, LibraryTabIcon, SearchTabIcon } from "@/components/icons/TabIcons";
import { selectionAsync } from "@/lib/haptics";
import { colors, layout } from "@/theme";

const TABS: Record<string, { label: string; Icon: typeof HomeTabIcon }> = {
  index: { label: "Home", Icon: HomeTabIcon },
  search: { label: "Search", Icon: SearchTabIcon },
  library: { label: "Your Library", Icon: LibraryTabIcon },
};

// Structural subset of expo-router's BottomTabBarProps (avoids a deep build-path
// import). `navigation` is loosely typed because its emit() generic doesn't
// assign cleanly to a hand-written signature.
type TabBarProps = {
  state: { index: number; routes: { key: string; name: string }[] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  navigation: any;
};

// Mirrors src/components/MobileNav.tsx: 3-tab grid, filled icon when active,
// gradient-to-top black backdrop + blur. The mini-player sits directly above it.
export function TabBar({ state, navigation }: TabBarProps) {
  const insets = useSafeAreaInsets();

  return (
    <View style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
      <MiniPlayer />
      <LinearGradient
        colors={["rgba(0,0,0,0.38)", "rgba(0,0,0,0.85)", "#000"]}
        style={{ paddingBottom: insets.bottom }}
      >
        <BlurView intensity={24} tint="dark" style={{ height: layout.mobileNavHeight, flexDirection: "row" }}>
          {state.routes.map((route, index) => {
            const config = TABS[route.name];
            if (!config) return null;
            const active = state.index === index;
            const onPress = () => {
              void selectionAsync();
              const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
              if (!active && !event.defaultPrevented) navigation.navigate(route.name);
            };
            const tint = active ? "#fff" : colors.muted;
            return (
              <PressableScale
                key={route.key}
                scaleTo={0.985}
                onPress={onPress}
                className="flex-1 items-center justify-center gap-1"
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={config.label}
              >
                <config.Icon active={active} color={tint} />
                <Text style={{ color: tint, fontSize: 10, fontWeight: "500" }}>{config.label}</Text>
              </PressableScale>
            );
          })}
        </BlurView>
      </LinearGradient>
    </View>
  );
}
