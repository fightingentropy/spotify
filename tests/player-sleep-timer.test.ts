import { beforeEach, describe, expect, test } from "bun:test";
import { sleepTimerRemainingMinutes, usePlayerStore } from "../src/store/player";

beforeEach(() => {
  usePlayerStore.setState({
    sleepTimerEndsAt: null,
    sleepAtEndOfTrack: false,
    isPlaying: false,
  });
});

describe("startSleepTimer", () => {
  test("sets endsAt that many minutes ahead", () => {
    const before = Date.now();
    usePlayerStore.getState().startSleepTimer(30);
    const after = Date.now();

    const { sleepTimerEndsAt } = usePlayerStore.getState();
    expect(sleepTimerEndsAt).not.toBeNull();
    expect(sleepTimerEndsAt!).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(sleepTimerEndsAt!).toBeLessThanOrEqual(after + 30 * 60_000);
  });

  test("clears an armed end-of-track flag", () => {
    usePlayerStore.getState().setSleepAtEndOfTrack();
    usePlayerStore.getState().startSleepTimer(5);

    const state = usePlayerStore.getState();
    expect(state.sleepAtEndOfTrack).toBe(false);
    expect(state.sleepTimerEndsAt).not.toBeNull();
  });

  test("restarting replaces the previous deadline", () => {
    usePlayerStore.getState().startSleepTimer(60);
    const first = usePlayerStore.getState().sleepTimerEndsAt!;

    usePlayerStore.getState().startSleepTimer(5);
    const second = usePlayerStore.getState().sleepTimerEndsAt!;

    expect(second).toBeLessThan(first);
  });

  test("does not touch playback state", () => {
    usePlayerStore.setState({ isPlaying: true });
    usePlayerStore.getState().startSleepTimer(15);
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });
});

describe("setSleepAtEndOfTrack", () => {
  test("arms the flag and clears any countdown", () => {
    usePlayerStore.getState().startSleepTimer(30);
    usePlayerStore.getState().setSleepAtEndOfTrack();

    const state = usePlayerStore.getState();
    expect(state.sleepAtEndOfTrack).toBe(true);
    expect(state.sleepTimerEndsAt).toBeNull();
  });
});

describe("cancelSleepTimer", () => {
  test("clears the countdown", () => {
    usePlayerStore.getState().startSleepTimer(30);
    usePlayerStore.getState().cancelSleepTimer();

    const state = usePlayerStore.getState();
    expect(state.sleepTimerEndsAt).toBeNull();
    expect(state.sleepAtEndOfTrack).toBe(false);
  });

  test("clears the end-of-track flag", () => {
    usePlayerStore.getState().setSleepAtEndOfTrack();
    usePlayerStore.getState().cancelSleepTimer();

    const state = usePlayerStore.getState();
    expect(state.sleepTimerEndsAt).toBeNull();
    expect(state.sleepAtEndOfTrack).toBe(false);
  });
});

describe("sleepTimerRemainingMinutes", () => {
  test("rounds up to the next whole minute", () => {
    const now = 1_000_000_000;
    expect(sleepTimerRemainingMinutes(now + 60_000, now)).toBe(1);
    expect(sleepTimerRemainingMinutes(now + 60_001, now)).toBe(2);
    expect(sleepTimerRemainingMinutes(now + 30 * 60_000, now)).toBe(30);
  });

  test("never reports below one minute, even past the deadline", () => {
    const now = 1_000_000_000;
    expect(sleepTimerRemainingMinutes(now + 1_000, now)).toBe(1);
    expect(sleepTimerRemainingMinutes(now - 5_000, now)).toBe(1);
  });
});
