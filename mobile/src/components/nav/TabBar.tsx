import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePathname, useRouter, type Href } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { BlurView } from "expo-blur";
import { PressableScale } from "@/components/ui/PressableScale";
import { CreateTabIcon, HomeTabIcon, LibraryTabIcon, SearchTabIcon } from "@/components/icons/TabIcons";
import { selectionAsync } from "@/lib/haptics";
import { useUiStore } from "@/store/ui";
import { usePrefsStore } from "@/store/prefs";
import { colors, layout } from "@/theme";

type TabKey = "index" | "search" | "library" | "create";

const TABS: { key: TabKey; label: string; path: Href; Icon: typeof HomeTabIcon }[] = [
  { key: "index", label: "Home", path: "/", Icon: HomeTabIcon },
  { key: "search", label: "Search", path: "/search", Icon: SearchTabIcon },
  { key: "library", label: "Your Library", path: "/library", Icon: LibraryTabIcon },
  // Create opens the create-menu sheet instead of navigating (handled in onPress).
  { key: "create", label: "Create", path: "/", Icon: CreateTabIcon },
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
  const openCreateMenu = useUiStore((s) => s.openCreateMenu);
  const showCreateTab = usePrefsStore((s) => s.showCreateTab);

  if (HIDDEN_ON.has(pathname)) return null;

  const active = activeTab(pathname);
  // Create can be hidden from Settings; when off, the other tabs spread evenly.
  const tabs = showCreateTab ? TABS : TABS.filter((tab) => tab.key !== "create");

  return (
    <View style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
      <LinearGradient
        colors={["rgba(0,0,0,0.38)", "rgba(0,0,0,0.85)", "#000"]}
        style={{ paddingBottom: insets.bottom }}
      >
        <BlurView intensity={24} tint="dark" style={{ height: layout.mobileNavHeight, flexDirection: "row" }}>
          {tabs.map((tab) => {
            const isActive = active === tab.key;
            const onPress = () => {
              void selectionAsync();
              // Create isn't a destination — it opens the create-menu sheet over
              // whatever's on screen, leaving the active tab untouched.
              if (tab.key === "create") {
                openCreateMenu();
                return;
              }
              // A tab tap should return to that tab's root. Sub-screens (a playlist,
              // Liked, …) are PUSHED on the root stack on top of the tabs, so first pop
              // the stack back to the tabs: dismissAll() dispatches POP_TO_TOP, which
              // unwinds and unmounts them cleanly (like the header back button, but all
              // the way). Using navigate() to "go back" here instead pushes a SECOND tabs
              // instance and leaves the sub-screen mounted underneath — duplicates that
              // never unmount. Then switch tab only if we're not already on it.
              if (router.canDismiss()) router.dismissAll();
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
