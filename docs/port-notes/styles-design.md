# Design System — `src/client/styles.css` + `src/lib/utils.ts`

Reconstruction-grade reference for porting the global CSS design system to **NativeWind / React Native**.
Source files:
- `/Users/erlinhoxha/Developer/spotify/src/client/styles.css` (362 lines — the ENTIRE global stylesheet)
- `/Users/erlinhoxha/Developer/spotify/src/lib/utils.ts` (`cn`, `formatTime`)

There is exactly **one** global CSS file. Everything else is Tailwind v4 utility classes inline on components. Tailwind v4 is loaded via `@import "tailwindcss";` (line 1) — there is no `tailwind.config.js`; theme tokens are declared inline in the `@theme inline` block.

---

## 1. Tailwind v4 setup

```css
@import "tailwindcss";
```

- Tailwind **v4**, configured **inline in CSS** (no JS config file). The `@theme inline { ... }` block registers theme tokens so utilities like `bg-background`, `text-foreground`, `font-sans`, `font-mono` resolve.
- **RN port note:** NativeWind v4 needs a `tailwind.config.js` + `global.css`. Recreate the tokens below in the `theme.extend` of the config (or in a `@theme` block if using NativeWind v4's CSS-first flow). NativeWind does NOT support `@theme inline` automatically — map tokens manually.

---

## 2. Color tokens / CSS custom properties

All custom properties are declared on `:root` (lines 3–14). Exact values:

| Custom property | Value | Meaning / use |
|---|---|---|
| `--background` | `#0a0a0a` | App background (near-black). Used on `body`, `#root`, `.wf-main`. |
| `--foreground` | `#ededed` | Default text color (off-white). |
| `--wf-left-sidebar-width` | `16rem` (= 256px) | Desktop left sidebar width; left offset of `.wf-main`. |
| `--wf-mobile-nav-height` | `3.25rem` (= 52px) | Mobile bottom nav bar height. |
| `--wf-mobile-player-height` | `4.25rem` (= 68px) | Mobile mini-player height. |
| `--wf-mobile-player-reserve-height` | `0px` (default) | Reserved space below content for the mini-player. Set to `--wf-mobile-player-height` only when `body.wf-has-mobile-player` is present (line 33). |
| `--wf-mobile-bottom-gutter` | `env(safe-area-inset-bottom, 0px)` | iOS home-indicator safe-area inset. |
| `--wf-mobile-nav-bottom-offset` | `calc(var(--wf-mobile-nav-height) + var(--wf-mobile-bottom-gutter))` | Combined nav + safe-area offset (declared but used as a helper). |

Theme-mapped colors in `@theme inline` (lines 16–21):

| Theme token | Resolves to | Tailwind utility it enables |
|---|---|---|
| `--color-background` | `var(--background)` = `#0a0a0a` | `bg-background`, `border-background`, etc. |
| `--color-foreground` | `var(--foreground)` = `#ededed` | `text-foreground`, etc. |

**Other hard-coded colors used in the stylesheet** (NOT custom properties — extract these as RN constants):

| Where | Color | Notes |
|---|---|---|
| Skeleton base bg (`.wf-skeleton`) | `rgba(255, 255, 255, 0.08)` | line 164 |
| Skeleton shimmer gradient (`.wf-skeleton::after`) | `linear-gradient(90deg, transparent, rgba(255,255,255,0.13), transparent)` | line 172 |
| Song-card shadow (`.wf-song-card`) | `0 12px 28px rgba(0,0,0,0)` (transparent — animatable to opaque on hover by component classes) | line 120 |
| Range slider thumb fill | `rgb(16 185 129)` (= `#10b981`, emerald-500 / **the Spotify-green accent**) | lines 338, 347 |
| Range slider thumb ring | `box-shadow: 0 0 0 2px var(--background)` (2px halo in `#0a0a0a`) | line 340 |
| Marquee edge fade mask | `linear-gradient(to right, transparent, black 14px, black calc(100% - 14px), transparent)` | line 265 |

**Accent color summary:** the primary accent throughout is **emerald-500 `#10b981` / `rgb(16 185 129)`** (the slider thumb). The app otherwise relies on Tailwind utility colors applied per-component (white/zinc/neutral grays + emerald accents) — those live in component className strings, not here.

`color-scheme: dark;` (line 12) — declares dark mode at the document level. In RN this maps to forcing a dark `Appearance`/StatusBar style; there is no equivalent CSS property.

---

## 3. Fonts & text rendering

Declared on `:root` (line 13) and re-mapped in `@theme inline` (lines 19–20):

```css
--font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
--font-mono: ui-mono, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
```
(exact `--font-mono` value: `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace`)

`body` font stack (line 13) is the same sans stack.

**Antialiasing / rendering (body, lines 27–29):**
```css
-webkit-font-smoothing: antialiased;
-moz-osx-font-smoothing: grayscale;
-webkit-tap-highlight-color: transparent;   /* kill the blue tap flash on touch */
```

**RN port notes:**
- The sans stack = "use the OS system font." In RN use the default system font (`System` on iOS, Roboto on Android) — do NOT bundle a custom font unless desired. No font files are referenced.
- `font-smoothing` properties have **no RN equivalent** and are unnecessary (RN text is already antialiased).
- `-webkit-tap-highlight-color: transparent` → in RN set `<TouchableOpacity>`/`<Pressable>` to not show Android ripple, or use the default (RN has no blue tap highlight). Effectively a no-op to port.
- `font-mono` is used for monospaced numerals (e.g. timecodes via `formatTime`). In RN use `fontVariant: ['tabular-nums']` or a monospace family if exact alignment matters.

---

## 4. Global layout rules (body / html / #root / .wf-main)

These are **web layout primitives** — most do NOT port directly. RN uses Flexbox + `SafeAreaView` instead. Documented for behavioral parity.

### Base (all viewports)
```css
body { margin: 0; background: #0a0a0a; color: #ededed; }            /* lines 23–30 */
html, body { min-height: 100%; overscroll-behavior-y: none; overflow-x: hidden; }  /* 36–41 */
#root { min-height: 100vh; min-height: 100dvh; background: #0a0a0a; }               /* 43–47 */
body.wf-now-playing-open { overflow: hidden; }   /* lock scroll when Now-Playing panel open — 49–51 */
```

`.wf-main` (lines 53–63) — the main scroll container:
```css
.wf-main {
  min-height: 100vh; min-height: 100dvh;
  min-width: 0;
  overflow-x: hidden;
  padding-left: 0; padding-right: 0;
  padding-bottom: calc(
    var(--wf-mobile-nav-height) +
    var(--wf-mobile-player-reserve-height) +
    var(--wf-mobile-bottom-gutter)
  );   /* reserves room for bottom nav + mini-player + safe area */
}
```

### Desktop — `@media (min-width: 1024px)` (lines 65–89)
```css
html, body, #root { height: 100%; }
body { overflow: hidden; }                 /* page itself doesn't scroll; .wf-main does */
.wf-main {
  position: fixed;
  min-height: 0;
  top: calc(3.5rem + env(safe-area-inset-top));   /* 56px top bar + safe area */
  right: 20rem;                                    /* 320px right panel (Now Playing / queue) */
  bottom: 84px;                                    /* 84px player bar */
  left: var(--wf-left-sidebar-width, 16rem);       /* 256px left sidebar */
  overflow-x: hidden; overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0;
  scrollbar-gutter: stable;
}
```
**Desktop layout = fixed 3-region chrome:** 256px left sidebar, 320px right panel, 56px top bar, 84px bottom player; `.wf-main` is the scrollable center filling the remainder.

### Mobile — `@media (max-width: 1023px)` (lines 298–325)
```css
html, body, #root { height: 100%; }
body { overflow: hidden; }
.wf-main {
  position: fixed;
  min-height: 0;
  top: calc(3.5rem + env(safe-area-inset-top));    /* 56px top bar + safe area */
  right: 0;
  bottom: calc(                                     /* nav + mini-player reserve + safe area */
    var(--wf-mobile-nav-height) +
    var(--wf-mobile-player-reserve-height) +
    var(--wf-mobile-bottom-gutter)
  );
  left: 0;
  overflow-x: hidden; overflow-y: auto;
  overscroll-behavior-y: contain;
  touch-action: pan-y;                  /* allow only vertical scroll */
  -webkit-overflow-scrolling: touch;    /* momentum scroll on iOS */
  padding: 0;
}
```

**Breakpoint:** the single layout breakpoint is **1024px** (`lg` in Tailwind). `<1024px` = mobile chrome, `>=1024px` = desktop chrome.

**RN port notes for §4:**
- `100vh`/`100dvh`, `position: fixed`, `env(safe-area-inset-*)`, `overflow`, `overscroll-behavior`, `touch-action`, `scrollbar-gutter`, `-webkit-overflow-scrolling` are **all web-only** → replace with RN `<SafeAreaView>` + flex layout + `<ScrollView>`/`<FlatList>`. Use `react-native-safe-area-context` `useSafeAreaInsets()` for the `env(safe-area-inset-*)` values.
- The content scroll area (`.wf-main`) becomes a `<ScrollView>` whose `contentContainerStyle.paddingBottom` = `navHeight (52) + miniPlayerReserve (0|68) + insets.bottom`.
- "Lock scroll when Now-Playing open" (`body.wf-now-playing-open`) → in RN, render the Now-Playing screen as a full-screen modal/route so the underlying list is unmounted or not scrollable.
- The class `body.wf-has-mobile-player` toggles whether the mini-player's height is reserved — in RN, conditionally add bottom padding when a track is loaded.

---

## 5. Component / utility classes (the `wf-*` system)

Custom non-Tailwind classes used across components. Recreate each as an RN style object / animation.

### `.touch-manipulation` (lines 91–93)
```css
touch-action: manipulation;   /* disable double-tap-to-zoom delay */
```
Web-only. No RN equivalent (no port needed).

### `.wf-route-surface` (lines 95–97, 185–189)
```css
.wf-route-surface { min-height: 100%; }
@media (prefers-reduced-motion: no-preference) {
  .wf-route-surface { animation: wf-route-enter 220ms cubic-bezier(0.16, 1, 0.3, 1) both; }
}
```
The wrapper applied to each route/page; plays the **route-enter** animation on mount (unless reduced-motion). → RN: an `Animated`/Reanimated entrance on screen mount (fade + 10px slide-up; see §6).

### `.wf-pressable` (lines 99–107)
Generic pressable surface. GPU-promoted + multi-prop transition:
```css
transform: translateZ(0);
transition:
  transform 160ms ease,
  background-color 160ms ease,
  border-color 160ms ease,
  box-shadow 180ms ease,
  opacity 160ms ease;
```
Active state (lines 176–179): `transform: scale(0.985)` **except** when it also has `.wf-list-row`.
→ RN: `Pressable` with `onPressIn/onPressOut` scaling to **0.985** over ~160ms. `translateZ(0)` is a GPU hint (drop it).

### `.wf-control-button` (lines 109–117)
Play/pause/skip-style control:
```css
transform: translateZ(0);
transition:
  transform 160ms ease,
  background-color 160ms ease,
  color 160ms ease,
  box-shadow 180ms ease,
  opacity 160ms ease;
```
Active (lines 177–179): `transform: scale(0.985)`.
→ RN: same press-scale (0.985, ~160ms ease) as `.wf-pressable`.

### `.wf-song-card` (lines 119–125, 181–183)
Album/song card with a "lift" interaction:
```css
box-shadow: 0 12px 28px rgba(0, 0, 0, 0);   /* shadow starts transparent */
transition:
  transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1),
  box-shadow 220ms ease,
  filter 220ms ease;
```
Active (line 181): `transform: scale(0.985)`.
(Hover lift — increasing shadow opacity/translateY — is applied via Tailwind hover classes on the component, not here; the base just declares the transparent shadow to animate from.)
→ RN: card press-scale to **0.985** over **220ms** with easing `cubic-bezier(0.2,0.8,0.2,1)`. Shadow lift on hover is desktop-only; on touch use the scale only. `filter` transition has no RN equivalent.

### `.wf-list-row` (lines 127–132)
Track/list row:
```css
transform: translateZ(0);
transition: background-color 170ms ease, opacity 170ms ease;
```
**Note:** explicitly **excluded** from the `:active` scale (the `.wf-pressable:active:not(.wf-list-row)` selector, line 176) — list rows change background, they do NOT scale on press.
→ RN: on press, change row background (e.g. to a subtle white overlay) over ~170ms; do NOT scale.

### `.wf-sheet-backdrop` (lines 134–136)
```css
transition: opacity 280ms ease;
```
Backdrop dim behind sheets/modals; fades over **280ms**.
→ RN: animated `Modal`/overlay opacity, 280ms ease.

### `.wf-now-playing-panel` (lines 138–154)
The sliding Now-Playing panel.
```css
transition:
  transform 360ms cubic-bezier(0.16, 1, 0.3, 1),   /* slide */
  opacity 260ms ease,
  border-color 260ms ease;
will-change: transform, opacity;
```
**Closing override** for `[data-open="false"]` (lines 151–154):
```css
transition-timing-function: cubic-bezier(0.4, 0, 1, 1), ease, ease;
transition-delay: 0ms, 120ms, 0ms;   /* hold opacity 120ms so it slides off before fading */
```
Design intent (verbatim comment, lines 146–150): opening **decelerates** into place (`cubic-bezier(0.16,1,0.3,1)`); closing **accelerates** out (`cubic-bezier(0.4,0,1,1)`) over the same 360ms, and **holds opacity** (120ms delay) until the panel has begun sliding so it glides off-screen instead of blinking out.
→ RN: drive with `data-open` boolean →
- **Open:** translate into place 360ms `cubic-bezier(0.16,1,0.3,1)`, opacity in 260ms ease.
- **Close:** translate out 360ms `cubic-bezier(0.4,0,1,1)`, opacity out 260ms ease but **delayed 120ms**.
Use Reanimated `withTiming` with `Easing.bezier(...)` and a 120ms delay on the closing opacity.

### `.wf-now-playing-art` (lines 156–159)
Album art inside Now-Playing:
```css
transform-origin: center;
animation: wf-cover-settle 520ms cubic-bezier(0.16, 1, 0.3, 1) both;
```
Plays the **cover-settle** entrance on mount (see §6). Disabled under reduced-motion (line 192).
→ RN: entrance animation on art mount (fade + rise + scale; see §6).

### `.wf-skeleton` + `::after` (lines 161–174)
Loading skeleton with sweeping shimmer:
```css
.wf-skeleton {
  position: relative; overflow: hidden;
  background: rgba(255, 255, 255, 0.08);
}
.wf-skeleton::after {
  position: absolute; inset: 0; content: "";
  transform: translateX(-100%);
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.13), transparent);
  animation: wf-skeleton-shimmer 1.25s ease-in-out infinite;
}
```
→ RN: a `View` with bg `rgba(255,255,255,0.08)` + an absolutely-positioned `LinearGradient` (`expo-linear-gradient`, horizontal, `[transparent, rgba(255,255,255,0.13), transparent]`) translated from `-100%` to `100%` looping every **1.25s** ease-in-out. (Or use a library like `react-native-skeleton-placeholder` / `moti` Skeleton.) Pseudo-elements don't exist in RN — make the shimmer a real child `View`.

### `.wf-marquee`, `.wf-marquee-inner`, `.wf-marquee-active` (lines 241–296)
Scrolling-text marquee for long titles.
```css
.wf-marquee { overflow: hidden; white-space: nowrap; max-width: 100%; min-width: 0; }
.wf-marquee-inner {
  display: inline-block; white-space: nowrap;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom;
}
.wf-marquee-active .wf-marquee-inner {
  max-width: none; overflow: visible;
  animation: wf-marquee-scroll var(--wf-marquee-duration, 9s) linear infinite;
  animation-delay: 1.5s;        /* sit still 1.5s before scrolling */
}
.wf-marquee-active {
  mask-image:        linear-gradient(to right, transparent, black 14px, black calc(100% - 14px), transparent);
  -webkit-mask-image: linear-gradient(to right, transparent, black 14px, black calc(100% - 14px), transparent);
}
```
Two CSS variables drive it (set per-instance in JS):
- `--wf-marquee-duration` (default `9s`)
- `--wf-marquee-distance` (default `0px`) — how far to scroll (= overflow width)

Reduced-motion override (lines 285–296): no animation, `max-width: 100%`, `overflow: hidden` (falls back to static ellipsis), and **mask removed**.

→ RN: this is the trickiest piece. There is no `mask-image` or `text-overflow` in core RN. Options:
- Measure text width vs container width (`onLayout`); if it overflows, mark active.
- Animate a horizontally-translating `Animated.Text` per the `wf-marquee-scroll` keyframe timing (§6), looping with the computed distance, 1.5s initial delay, 9s default duration.
- Edge fade mask: use `expo-linear-gradient` + `MaskedView` (`@react-native-masked-view/masked-view`) with a horizontal gradient transparent→black at 14px→black at (width-14px)→transparent. Inactive/short titles: just `numberOfLines={1}` with `ellipsizeMode="tail"`.

---

## 6. `@keyframes` animations — full table

Every keyframe with exact transform/opacity values. Easings/durations are set on the consuming class (noted).

### `wf-route-enter` (lines 210–220)
Used by `.wf-route-surface` — **220ms**, `cubic-bezier(0.16, 1, 0.3, 1)`, fill `both`.
| Keyframe | opacity | transform |
|---|---|---|
| `from` | `0` | `translateY(10px)` |
| `to` | `1` | `translateY(0)` |

### `wf-cover-settle` (lines 222–232)
Used by `.wf-now-playing-art` — **520ms**, `cubic-bezier(0.16, 1, 0.3, 1)`, fill `both`.
| Keyframe | opacity | transform |
|---|---|---|
| `from` | `0` | `translateY(14px) scale(0.965)` |
| `to` | `1` | `translateY(0) scale(1)` |

### `wf-skeleton-shimmer` (lines 235–239)
Used by `.wf-skeleton::after` — **1.25s**, `ease-in-out`, `infinite`. Start state is set by the rule (`transform: translateX(-100%)`).
| Keyframe | transform |
|---|---|
| (implicit start) | `translateX(-100%)` |
| `to` | `translateX(100%)` |

### `wf-marquee-scroll` (lines 269–283)
Used by `.wf-marquee-active .wf-marquee-inner` — duration `var(--wf-marquee-duration, 9s)`, `linear`, `infinite`, `animation-delay: 1.5s`. Distance var = `var(--wf-marquee-distance, 0px)`.
| Keyframe | transform |
|---|---|
| `0%`, `12%` | `translateX(0)` (dwell at start ~12% of cycle) |
| `78%`, `92%` | `translateX(calc(-1 * var(--wf-marquee-distance, 0px)))` (dwell at end) |
| `100%` | `translateX(0)` (snap/return to start) |

Behavior: hold at start (0–12%), scroll left to `-distance` (12%→78%), hold at end (78–92%), return to 0 (92→100%).

**Easing cheat-sheet (Bezier control points → RN `Easing.bezier(...)`):**
| Name (where used) | cubic-bezier | Feel |
|---|---|---|
| Route enter / cover settle / panel **open** | `0.16, 1, 0.3, 1` | strong decelerate (ease-out expo-ish) |
| Panel **close** (opacity/transform) | `0.4, 0, 1, 1` | accelerate in (ease-in) |
| Song-card transform | `0.2, 0.8, 0.2, 1` | smooth ease-in-out-ish |
| Misc (`ease`, `ease-in-out`, `linear`) | CSS defaults | — |

---

## 7. Reduced-motion handling

Two `@media (prefers-reduced-motion: reduce)` blocks.

**Block 1 (lines 191–208):**
- `.wf-route-surface`, `.wf-now-playing-art`, `.wf-skeleton::after` → `animation: none` (no entrance, no shimmer).
- `.wf-pressable`, `.wf-control-button`, `.wf-song-card`, `.wf-list-row`, `.wf-sheet-backdrop`, `.wf-now-playing-panel`, `.wf-now-playing-panel[data-open="false"]` → `transition-duration: 1ms; transition-delay: 0ms;` (effectively instant, but still technically transitioned).

**Block 2 (lines 285–296):** marquee — `.wf-marquee-active .wf-marquee-inner` → `animation: none; max-width: 100%; overflow: hidden;` and `.wf-marquee-active` → `mask-image: none`.

Also note the **positive** guard: route-enter animation only runs under `@media (prefers-reduced-motion: no-preference)` (lines 185–189).

→ RN port: read `AccessibilityInfo.isReduceMotionEnabled()` (and subscribe to `reduceMotionChanged`). When true: skip all entrance animations and shimmer, make press transitions instant (~1ms), disable the marquee scroll (fall back to static ellipsized text, no edge-fade mask).

---

## 8. Form controls — range slider (lines 327–361)

Custom-styled `<input type="range">` (used for the seek/progress bar and likely volume).
```css
input[type="range"] { -webkit-appearance: none; appearance: none; }

input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 14px; height: 14px;
  border-radius: 9999px;
  background: rgb(16 185 129);          /* emerald-500 #10b981 */
  border: none;
  box-shadow: 0 0 0 2px var(--background);   /* 2px #0a0a0a halo */
}
input[type="range"]::-moz-range-thumb {
  width: 14px; height: 14px; border-radius: 9999px;
  background: rgb(16 185 129); border: none;
}

/* mobile (<=1023px): bigger thumb */
@media (max-width: 1023px) {
  input[type="range"]::-webkit-slider-thumb { width: 16px; height: 16px; }
  input[type="range"]::-moz-range-thumb    { width: 16px; height: 16px; }
}
```
**Thumb spec:** circle (`border-radius: 9999px`), emerald-500 fill, no border; **14×14px desktop**, **16×16px mobile**; webkit thumb has a 2px `#0a0a0a` ring. The track itself is styled per-component (not in this file).

→ RN: there is **no native `<input type=range>`**. Use `@react-native-community/slider` or a Reanimated custom slider. Reproduce: thumb 16×16, fully round, fill `#10b981`; `thumbTintColor="#10b981"`, `minimumTrackTintColor` = emerald, `maximumTrackTintColor` = a dark gray. Add a 2px dark ring around the thumb if matching exactly (custom thumb image/view).

**PORTING HAZARD:** `<input type="range">` is web-only. All seek/volume sliders must be rewritten with an RN slider component.

---

## 9. `src/lib/utils.ts`

Two exported helpers (no React/web-specific deps; both port as-is to RN).

### `cn(...inputs: ClassValue[]): string`
```ts
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```
Standard shadcn-style class combiner: `clsx` resolves conditionals, `tailwind-merge` dedupes conflicting Tailwind classes (last wins).
→ RN: NativeWind supports the same pattern. Keep `cn` verbatim. `clsx` works in RN unchanged. `tailwind-merge` works on className strings (no DOM dependency) — keep it; NativeWind consumes the merged `className`. **No changes needed.**

### `formatTime(totalSeconds: number | null | undefined): string`
```ts
export function formatTime(totalSeconds) {
  if (totalSeconds == null || Number.isNaN(totalSeconds)) return "--:--";
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hrs  = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const two = (n) => n.toString().padStart(2, "0");
  return hrs > 0 ? `${hrs}:${two(mins)}:${two(secs)}` : `${mins}:${two(secs)}`;
}
```
- Null/NaN → `"--:--"`.
- Clamps negatives to 0.
- `< 1h` → `M:SS` (minutes NOT zero-padded). `>= 1h` → `H:MM:SS`.
→ Pure JS, **ports as-is**. Display the result in a monospace / `tabular-nums` `<Text>` to avoid jitter.

---

## 10. PORTING HAZARDS (this file)

1. **`<input type="range">`** (§8) — web-only; rewrite all sliders with an RN slider. The thumb spec (16×16 round, `#10b981`, 2px dark ring) and behavior must be reproduced manually.
2. **Layout primitives** — `position: fixed`, `100vh`/`100dvh`, `env(safe-area-inset-*)`, `overflow`/`overscroll-behavior`/`touch-action`/`scrollbar-gutter`/`-webkit-overflow-scrolling`, and the whole fixed-chrome model (`.wf-main` offsets) are web-only. Rebuild with Flexbox + `SafeAreaView` + `ScrollView`/`FlatList`. Map `env(safe-area-inset-*)` → `useSafeAreaInsets()`.
3. **CSS animations & `@keyframes`** — must be reimplemented with `Animated`/Reanimated. Most matter: route-enter (220ms), cover-settle (520ms), skeleton shimmer (1.25s loop), the Now-Playing open/close asymmetric easing (360ms in / out with 120ms opacity hold), and the marquee.
4. **Marquee** — needs `mask-image` (→ `MaskedView` + `expo-linear-gradient`) and `text-overflow` (→ `numberOfLines`); text-width measurement via `onLayout` to decide active vs static.
5. **Pseudo-elements** (`.wf-skeleton::after`) — RN has none; make the shimmer a real child `View`.
6. **`@theme inline` / no JS Tailwind config** — NativeWind needs an explicit `tailwind.config.js`; recreate every token in §2 there (`background #0a0a0a`, `foreground #ededed`, the `--wf-*` layout constants as JS constants, accent `#10b981`).
7. **`color-scheme: dark`, `-webkit-font-smoothing`, `-webkit-tap-highlight-color`** — no RN equivalents; handle dark mode via `Appearance`/StatusBar; smoothing/tap-highlight are no-ops.
8. **`prefers-reduced-motion`** → `AccessibilityInfo.isReduceMotionEnabled()` + subscription; gate every animation on it.
9. **`body.wf-*` global class toggles** (`wf-has-mobile-player`, `wf-now-playing-open`) — these mutate global layout via the `document.body` classList. In RN there is no `document`; replace with app-state booleans (e.g. Zustand) that drive conditional padding / modal presentation.

---

## 11. Quick-reference constant dump (for the RN theme file)

```ts
export const colors = {
  background: "#0a0a0a",     // --background
  foreground: "#ededed",     // --foreground
  accent:     "#10b981",     // emerald-500, slider thumb (rgb 16 185 129)
  skeletonBase:    "rgba(255,255,255,0.08)",
  skeletonShimmer: "rgba(255,255,255,0.13)",
};

export const layout = {
  leftSidebarWidth:        256,  // 16rem (desktop only)
  rightPanelWidth:         320,  // 20rem (desktop only)
  topBarHeight:            56,   // 3.5rem
  desktopPlayerBarHeight:  84,
  mobileNavHeight:         52,   // 3.25rem
  mobilePlayerHeight:      68,   // 4.25rem
  breakpointLg:            1024, // mobile <-> desktop
};

export const motion = {
  routeEnter:    { ms: 220, bezier: [0.16, 1, 0.3, 1] },   // fade + translateY 10->0
  coverSettle:   { ms: 520, bezier: [0.16, 1, 0.3, 1] },   // fade + translateY 14->0 + scale .965->1
  skeleton:      { ms: 1250, loop: true },                 // translateX -100% -> 100%, ease-in-out
  pressScale:    { ms: 160, scale: 0.985 },                // pressable/control buttons
  cardPress:     { ms: 220, scale: 0.985, bezier: [0.2, 0.8, 0.2, 1] },
  listRow:       { ms: 170 },                              // bg/opacity only, NO scale
  sheetBackdrop: { ms: 280 },                              // opacity
  npOpen:        { ms: 360, bezier: [0.16, 1, 0.3, 1], opacityMs: 260 },
  npClose:       { ms: 360, bezier: [0.4, 0, 1, 1], opacityMs: 260, opacityDelayMs: 120 },
  marquee:       { ms: 9000, startDelayMs: 1500, edgeFadePx: 14 },  // default duration; distance computed
  reducedMotion: { ms: 1 },
};
```
