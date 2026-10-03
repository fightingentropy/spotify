import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getPlaybackPosition,
  PLAYBACK_SEEK_REQUEST_EVENT,
  publishPlaybackPosition,
  requestPlaybackSeek,
  subscribePlaybackPosition,
} from "../src/lib/playback-position";

const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

beforeEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
  publishPlaybackPosition({ currentTime: 0, duration: 0 });
});

afterEach(() => {
  if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
  else delete (globalThis as Record<string, unknown>).window;
});

describe("playback position for lyrics", () => {
  test("opens at the current position while paused without waiting for another tick", () => {
    publishPlaybackPosition({ currentTime: 73, duration: 210 });
    const positions: number[] = [];
    const unsubscribe = subscribePlaybackPosition((position) => positions.push(position.currentTime));
    expect(positions).toEqual([73]);
    expect(getPlaybackPosition()).toEqual({ currentTime: 73, duration: 210 });
    unsubscribe();
  });

  test("follows seeking and stops receiving updates after the view closes", () => {
    const positions: number[] = [];
    const unsubscribe = subscribePlaybackPosition((position) => positions.push(position.currentTime));
    publishPlaybackPosition({ currentTime: 24, duration: 210 });
    publishPlaybackPosition({ currentTime: 9, duration: 210 });
    unsubscribe();
    publishPlaybackPosition({ currentTime: 42, duration: 210 });
    expect(positions).toEqual([0, 24, 9]);
  });

  test("forwards a timed lyric tap to the player and rejects invalid timestamps", () => {
    const requests: number[] = [];
    window.addEventListener(PLAYBACK_SEEK_REQUEST_EVENT, (event) => requests.push((event as CustomEvent<number>).detail));
    requestPlaybackSeek(65.2);
    requestPlaybackSeek(Number.NaN);
    requestPlaybackSeek(Number.POSITIVE_INFINITY);
    expect(requests).toEqual([65.2]);
  });
});
