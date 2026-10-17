import { Platform } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import Svg, { Circle, Path, Rect } from "react-native-svg";

// iOS renders SF Symbols. Android draws the same shapes (house, magnifier,
// stacked square, plus) on a 24px grid so both apps share one tab-bar look:
// outline at rest, filled when active.
type Props = { active: boolean; color: string; size?: number };

function IOSTabSymbol({
  name,
  active,
  color,
  size,
}: {
  name: SFSymbol;
  active: boolean;
  color: string;
  size: number;
}) {
  return (
    <SymbolView
      name={name}
      size={size}
      tintColor={color}
      type="hierarchical"
      weight={active ? "semibold" : "medium"}
      animationSpec={
        active
          ? { effect: { type: "bounce", wholeSymbol: true }, speed: 1.2 }
          : undefined
      }
      style={{ width: size, height: size }}
    />
  );
}

export function HomeTabIcon({ active, color, size = 24 }: Props) {
  if (Platform.OS === "ios") {
    return (
      <IOSTabSymbol
        name={active ? "house.fill" : "house"}
        active={active}
        color={color}
        size={size}
      />
    );
  }
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size}>
      {active ? (
        <Path
          fill={color}
          fillRule="evenodd"
          d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM10 21v-6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v6z"
        />
      ) : (
        <>
          <Path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="none" stroke={color} strokeWidth={1.9} strokeLinejoin="round" />
          <Path d="M10 21v-6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v6" fill="none" stroke={color} strokeWidth={1.9} strokeLinejoin="round" />
        </>
      )}
    </Svg>
  );
}

export function SearchTabIcon({ active, color, size = 24 }: Props) {
  if (Platform.OS === "ios") {
    return (
      <IOSTabSymbol
        name="magnifyingglass"
        active={active}
        color={color}
        size={size}
      />
    );
  }
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke={color} strokeLinecap="round">
      <Circle cx="10.5" cy="10.5" r="7" strokeWidth={active ? 2.6 : 2} />
      <Path d="m15.7 15.7 5.3 5.3" strokeWidth={active ? 2.8 : 2.2} />
    </Svg>
  );
}

export function LibraryTabIcon({ active, color, size = 24 }: Props) {
  if (Platform.OS === "ios") {
    return (
      <IOSTabSymbol
        name={active ? "square.stack.fill" : "square.stack"}
        active={active}
        color={color}
        size={size}
      />
    );
  }
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round">
      <Path d="M8 3h8M6 6.5h12" />
      <Rect x="3.5" y="10" width="17" height="11.5" rx="2.5" fill={active ? color : "none"} strokeLinejoin="round" />
    </Svg>
  );
}

// "Create" is an action (it opens the create sheet), not a selectable tab, so it
// renders the same + glyph regardless of `active`.
export function CreateTabIcon({ color, size = 24 }: Props) {
  if (Platform.OS === "ios") {
    return <IOSTabSymbol name="plus" active={false} color={color} size={size} />;
  }
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size}>
      <Path d="M12 4.5v15M4.5 12h15" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
    </Svg>
  );
}
