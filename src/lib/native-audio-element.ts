import { AudioEngine, type AudioDeck } from "./native-audio";

// A stand-in for HTMLAudioElement, backed by one native AVPlayer "deck" (A/B).
// On iOS the player drives two of these instead of <audio> elements so playback
// (and the crossfade) run in native code the OS keeps alive when the screen
// locks. It implements only the slice of HTMLAudioElement that PlayerBar.tsx and
// use-media-session touch — see docs/native-audio-engine.md.

type AdapterEvent = { type: string; currentTarget: NativeAudioElement; target: NativeAudioElement };
type AdapterListener = (event: AdapterEvent) => void;

// HTMLMediaElement.readyState levels we report.
const HAVE_NOTHING = 0;
const HAVE_ENOUGH_DATA = 4;

// A capacitor file URL (capacitor://localhost/_capacitor_file_/var/…) can't be
// loaded by AVPlayer. Recover the raw filesystem path so the native prepare uses
// URL(fileURLWithPath:). http(s) and HLS (m3u8) URLs pass straight through.
const CAPACITOR_FILE_MARKER = "/_capacitor_file_/";
function toNativePlayableUrl(url: string): string {
  const index = url.indexOf(CAPACITOR_FILE_MARKER);
  if (index < 0) return url;
  const encodedPath = url.slice(index + CAPACITOR_FILE_MARKER.length - 1); // keep the leading "/"
  try {
    return decodeURIComponent(encodedPath);
  } catch {
    return encodedPath;
  }
}

// One global set of plugin listeners routes deck-tagged events to the right
// adapter. Adapters are app-lifetime singletons (one per deck), so no teardown.
const adaptersByDeck = new Map<AudioDeck, NativeAudioElement>();
let pluginListenersWired = false;

function wirePluginListeners(): void {
  if (pluginListenersWired) return;
  pluginListenersWired = true;
  void AudioEngine.addListener("time", (e) => adaptersByDeck.get(e.deck)?.handleTime(e.currentTime, e.duration));
  void AudioEngine.addListener("loaded", (e) => adaptersByDeck.get(e.deck)?.handleLoaded(e.duration));
  void AudioEngine.addListener("ended", (e) => adaptersByDeck.get(e.deck)?.handleEnded());
  void AudioEngine.addListener("playing", (e) => adaptersByDeck.get(e.deck)?.handlePlaying());
  void AudioEngine.addListener("waiting", (e) => adaptersByDeck.get(e.deck)?.dispatch("waiting"));
  void AudioEngine.addListener("seeked", (e) => adaptersByDeck.get(e.deck)?.handleSeeked(e.currentTime));
  void AudioEngine.addListener("error", (e) => adaptersByDeck.get(e.deck)?.handleError());
}

export class NativeAudioElement {
  readonly deck: AudioDeck;
  private readonly listeners = new Map<string, Set<AdapterListener>>();
  private _src = "";
  private _currentTime = 0;
  private _duration = 0;
  private _volume = 1;
  private _muted = false;
  private _playbackRate = 1;
  private _paused = true;
  private _readyState = HAVE_NOTHING;
  // Position to seek to once the next source is ready (resume points set before
  // metadata loads). HTMLMediaElement would buffer the currentTime write; AVPlayer
  // takes it as a prepare option instead.
  private pendingStartAt = 0;
  // Accepted-and-ignored to match the HTMLAudioElement API PlayerBar sets.
  defaultPlaybackRate = 1;
  crossOrigin: string | null = null;

  constructor(deck: AudioDeck) {
    this.deck = deck;
    adaptersByDeck.set(deck, this);
    wirePluginListeners();
  }

  get src(): string {
    return this._src;
  }
  set src(value: string) {
    if (value === this._src) return;
    this._src = value;
    this._readyState = HAVE_NOTHING;
    this._duration = 0;
    if (!value) {
      void AudioEngine.stop({ deck: this.deck }).catch(() => {});
      return;
    }
    const startAt = this.pendingStartAt;
    this.pendingStartAt = 0;
    void AudioEngine.prepare({ deck: this.deck, url: toNativePlayableUrl(value), startAt }).catch(() => {});
  }
  get currentSrc(): string {
    return this._src;
  }

  get currentTime(): number {
    return this._currentTime;
  }
  set currentTime(value: number) {
    if (!Number.isFinite(value)) return;
    this._currentTime = value; // optimistic so PlayerBar's seekIsCloseEnough check passes
    if (this._readyState < HAVE_ENOUGH_DATA) {
      this.pendingStartAt = value;
      return;
    }
    void AudioEngine.seek({ deck: this.deck, position: value }).catch(() => {});
  }

  // HTMLMediaElement reports NaN before metadata; PlayerBar's finiteMediaDuration
  // depends on that to fall back to the catalog duration.
  get duration(): number {
    return this._duration > 0 ? this._duration : NaN;
  }

  get volume(): number {
    return this._volume;
  }
  set volume(value: number) {
    const next = Math.max(0, Math.min(1, value));
    this._volume = next;
    void AudioEngine.setVolume({ deck: this.deck, volume: this._muted ? 0 : next }).catch(() => {});
  }

  get muted(): boolean {
    return this._muted;
  }
  set muted(value: boolean) {
    this._muted = value;
    void AudioEngine.setVolume({ deck: this.deck, volume: value ? 0 : this._volume }).catch(() => {});
  }

  get playbackRate(): number {
    return this._playbackRate;
  }
  set playbackRate(value: number) {
    if (!Number.isFinite(value) || value <= 0) return;
    this._playbackRate = value;
    void AudioEngine.setRate({ deck: this.deck, rate: value }).catch(() => {});
  }

  get paused(): boolean {
    return this._paused;
  }
  get readyState(): number {
    return this._readyState;
  }

  play(): Promise<void> {
    this._paused = false;
    this.dispatch("play");
    return AudioEngine.play({ deck: this.deck }).catch(() => {});
  }
  pause(): void {
    this._paused = true;
    void AudioEngine.pause({ deck: this.deck }).catch(() => {});
    this.dispatch("pause");
  }
  load(): void {
    if (this._src) {
      void AudioEngine.prepare({
        deck: this.deck,
        url: toNativePlayableUrl(this._src),
        startAt: this.pendingStartAt,
      }).catch(() => {});
    }
  }
  removeAttribute(name: string): void {
    if (name !== "src") return;
    this._src = "";
    this._readyState = HAVE_NOTHING;
    void AudioEngine.stop({ deck: this.deck }).catch(() => {});
  }

  addEventListener(type: string, listener: AdapterListener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }
  removeEventListener(type: string, listener: AdapterListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  // --- plugin event handlers ---------------------------------------------------

  handleTime(currentTime: number, duration: number): void {
    this._currentTime = currentTime;
    if (duration > 0 && duration !== this._duration) {
      this._duration = duration;
      this.dispatch("durationchange");
    }
    this.dispatch("timeupdate");
  }
  handleLoaded(duration: number): void {
    if (duration > 0) this._duration = duration;
    this._readyState = HAVE_ENOUGH_DATA;
    // Fire the cluster of "ready" events PlayerBar listens for (it applies resume
    // seeks on loadedmetadata and clears retry state on canplay).
    this.dispatch("loadedmetadata");
    this.dispatch("durationchange");
    this.dispatch("loadeddata");
    this.dispatch("canplay");
    this.dispatch("canplaythrough");
  }
  handleEnded(): void {
    this._paused = true;
    this.dispatch("ended");
  }
  handlePlaying(): void {
    this._paused = false;
    if (this._readyState < HAVE_ENOUGH_DATA) this._readyState = HAVE_ENOUGH_DATA;
    this.dispatch("playing");
  }
  handleSeeked(time: number): void {
    this._currentTime = time;
    this.dispatch("seeked");
  }
  handleError(): void {
    this.dispatch("error");
  }

  dispatch(type: string): void {
    const set = this.listeners.get(type);
    if (!set || set.size === 0) return;
    const event: AdapterEvent = { type, currentTarget: this, target: this };
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch {
        // a listener throwing must not wedge the rest
      }
    }
  }
}

export function deckForIndex(index: 0 | 1): AudioDeck {
  return index === 0 ? "A" : "B";
}
