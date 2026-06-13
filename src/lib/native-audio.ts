import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

// TS bridge for the native iOS AVFoundation engine (ios/App/App/AudioEnginePlugin.swift).
// The web player drives this on iOS so playback survives a locked screen and the
// crossfade ramp runs in native code the OS keeps alive. See docs/native-audio-engine.md.

export type AudioDeck = "A" | "B";

export type AudioEngineRemoteAction = "play" | "pause" | "toggle" | "next" | "prev" | "seek";

export type AudioEngineTimeEvent = { deck: AudioDeck; currentTime: number; duration: number };
export type AudioEngineLoadedEvent = { deck: AudioDeck; duration: number };
export type AudioEngineDeckEvent = { deck: AudioDeck };
export type AudioEngineSeekedEvent = { deck: AudioDeck; currentTime: number };
export type AudioEngineErrorEvent = { deck: AudioDeck; message: string };
export type AudioEngineCrossfadeEvent = { from: AudioDeck; to: AudioDeck };
export type AudioEngineRemoteEvent = { action: AudioEngineRemoteAction; value?: number };

export interface AudioEnginePlugin {
  configure(): Promise<void>;
  // M1a: only put the shared AVAudioSession into .playback + active (audio still
  // plays from the WebView <audio> element). Keeps it alive across a screen lock.
  activateSession(): Promise<void>;
  prepare(options: { deck: AudioDeck; id?: string; url: string; startAt?: number }): Promise<void>;
  play(options: { deck: AudioDeck }): Promise<void>;
  pause(options: { deck: AudioDeck }): Promise<void>;
  stop(options: { deck: AudioDeck }): Promise<void>;
  seek(options: { deck: AudioDeck; position: number }): Promise<void>;
  setVolume(options: { deck: AudioDeck; volume: number }): Promise<void>;
  setRate(options: { deck: AudioDeck; rate: number }): Promise<void>;
  crossfade(options: { from: AudioDeck; to: AudioDeck; durationMs: number; peak: number }): Promise<void>;
  setActiveDeck(options: { deck: AudioDeck }): Promise<void>;
  setNowPlaying(options: {
    title: string;
    artist: string;
    album?: string;
    artworkUrl?: string;
    duration?: number;
  }): Promise<void>;
  updateNowPlaying(options: { position: number; rate: number; playing: boolean }): Promise<void>;
  releaseDeck(options: { deck: AudioDeck }): Promise<void>;

  addListener(eventName: "time", listenerFunc: (event: AudioEngineTimeEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "loaded", listenerFunc: (event: AudioEngineLoadedEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "ended", listenerFunc: (event: AudioEngineDeckEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "playing", listenerFunc: (event: AudioEngineDeckEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "waiting", listenerFunc: (event: AudioEngineDeckEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "seeked", listenerFunc: (event: AudioEngineSeekedEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "error", listenerFunc: (event: AudioEngineErrorEvent) => void): Promise<PluginListenerHandle>;
  addListener(
    eventName: "crossfadeComplete",
    listenerFunc: (event: AudioEngineCrossfadeEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(eventName: "remote", listenerFunc: (event: AudioEngineRemoteEvent) => void): Promise<PluginListenerHandle>;
}

export const AudioEngine = registerPlugin<AudioEnginePlugin>("AudioEngine");

// The native engine only exists in the iOS Capacitor build. Desktop/Android keep
// the HTMLAudioElement + audio.volume path (no AudioContext, no "locked" state).
export function isNativeAudioPlatform(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
  } catch {
    return false;
  }
}
