import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePathname, useRouter, type Href } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { BlurView } from "expo-blur";
import { PressableScale } from "@/components/ui/PressableScale";
import { HomeTabIcon, LibraryTabIcon, SearchTabIcon } from "@/components/icons/TabIcons";
import { selectionAsync } from "@/lib/haptics";
import { colors, layout } from "@/theme";

type TabKey = "index" | "search" | "library";

const TABS: { key: TabKey; label: string; path: Href; Icon: typeof HomeTabIcon }[] = [
  { key: "index", label: "Home", path: "/", Icon: HomeTabIcon },
  { key: "search", label: "Search", path: "/search", Icon: SearchTabIcon },
  { key: "library", label: "Your Library", path: "/library", Icon: LibraryTabIcon },
];

// Auth screens take over the whole screen — no tab bar there.
const HIDDEN_ON = new Set(["/signin", "/register"]);

// Which tab "owns" the current route, so the right icon stays lit on pushed screens
// (e.g. /liked and /playlist were reached from Library). Home and Search match their
// own paths; every other pushed screen falls back to Library.
function activeTab(pathname: string): TabKey {
  if (pathname === "/") return "index";
  if (pathname.startsWith("/search")) return "search";
  return "library";
}

// Mirrors src/components/MobileNav.tsx: 3-tab grid, filled icon when active,
// gradient-to-top black backdrop + blur. Mounted once in the root layout (not via the
// Tabs navigator's tabBar prop) so it persists on pushed stack screens too — liked,
// playlist, downloads, … — not just the tabs. Driven by the router: navigate() unwinds
// any pushed screen and switches tab in one step.
export function TabBar() {
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const router = useRouter();

  if (HIDDEN_ON.has(pathname)) return null;

  const active = activeTab(pathname);

  return (
    <View style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
      <LinearGradient
        colors={["rgba(0,0,0,0.38)", "rgba(0,0,0,0.85)", "#000"]}
        style={{ paddingBottom: insets.bottom }}
      >
        <BlurView intensity={24} tint="dark" style={{ height: layout.mobileNavHeight, flexDirection: "row" }}>
          {TABS.map((tab) => {
            const isActive = active === tab.key;
            const onPress = () => {
              void selectionAsync();
              if (!isActive) router.navigate(tab.path);
            };
            const tint = isActive ? "#fff" : colors.muted;
            return (
              <PressableScale
                key={tab.key}
                scaleTo={0.985}
                onPress={onPress}
                className="flex-1 items-center justify-center gap-1"
                accessibilityRole="button"
                accessibilityState={{ selected: isActive }}
                accessibilityLabel={tab.label}
              >
                <tab.Icon active={isActive} color={tint} />
                <Text style={{ color: tint, fontSize: 10, fontWeight: "500" }}>{tab.label}</Text>
              </PressableScale>
            );
          })}
        </BlurView>
      </LinearGradient>
    </View>
  );
}
