import { describe, expect, test } from "bun:test";
import {
  EQUAL_POWER_RAMP_STEPS,
  equalPowerGain,
  scheduleEqualPowerRamp,
} from "../src/lib/crossfade-curve";

describe("equalPowerGain", () => {
  test("endpoints are exact: out goes 1→0, in goes 0→1", () => {
    expect(equalPowerGain(0, "out")).toBeCloseTo(1, 10);
    expect(equalPowerGain(1, "out")).toBeCloseTo(0, 10);
    expect(equalPowerGain(0, "in")).toBeCloseTo(0, 10);
    expect(equalPowerGain(1, "in")).toBeCloseTo(1, 10);
  });

  test("progress is clamped to [0,1]", () => {
    expect(equalPowerGain(-5, "out")).toBe(equalPowerGain(0, "out"));
    expect(equalPowerGain(-5, "in")).toBe(equalPowerGain(0, "in"));
    expect(equalPowerGain(5, "out")).toBe(equalPowerGain(1, "out"));
    expect(equalPowerGain(5, "in")).toBe(equalPowerGain(1, "in"));
  });

  test("constant power: out² + in² == 1 across the whole fade (no mid-fade dip)", () => {
    for (let i = 0; i <= 100; i += 1) {
      const t = i / 100;
      const out = equalPowerGain(t, "out");
      const incoming = equalPowerGain(t, "in");
      expect(out * out + incoming * incoming).toBeCloseTo(1, 10);
    }
  });

  test("at the midpoint both tracks sit at 1/√2 — combined power 1, not 0.5 like a linear fade", () => {
    const out = equalPowerGain(0.5, "out");
    const incoming = equalPowerGain(0.5, "in");
    expect(out).toBeCloseTo(Math.SQRT1_2, 10);
    expect(incoming).toBeCloseTo(Math.SQRT1_2, 10);
    // A linear crossfade would put both at 0.5 here → combined power 0.5 (≈ -3 dB dip).
    expect(out * out + incoming * incoming).toBeCloseTo(1, 10);
  });

  test("monotonic: out only falls, in only rises", () => {
    let prevOut = equalPowerGain(0, "out");
    let prevIn = equalPowerGain(0, "in");
    for (let i = 1; i <= 50; i += 1) {
      const t = i / 50;
      const out = equalPowerGain(t, "out");
      const incoming = equalPowerGain(t, "in");
      expect(out).toBeLessThanOrEqual(prevOut + 1e-12);
      expect(incoming).toBeGreaterThanOrEqual(prevIn - 1e-12);
      prevOut = out;
      prevIn = incoming;
    }
  });
});

type ParamCall =
  | { kind: "cancel"; time: number }
  | { kind: "setValue"; value: number; time: number }
  | { kind: "ramp"; value: number; time: number };

function fakeAudioParam() {
  const calls: ParamCall[] = [];
  const param = {
    cancelScheduledValues(time: number) {
      calls.push({ kind: "cancel", time });
    },
    setValueAtTime(value: number, time: number) {
      calls.push({ kind: "setValue", value, time });
    },
    linearRampToValueAtTime(value: number, time: number) {
      calls.push({ kind: "ramp", value, time });
    },
  } as unknown as AudioParam;
  return { param, calls };
}

describe("scheduleEqualPowerRamp", () => {
  test("anchors then ramps along the curve, scaled to peak and the fade window", () => {
    const { param, calls } = fakeAudioParam();
    const t0 = 10;
    const duration = 4;
    const peak = 0.8;
    scheduleEqualPowerRamp(param, t0, duration, peak, "out");

    expect(calls[0]).toEqual({ kind: "cancel", time: t0 });
    expect(calls[1]).toEqual({ kind: "setValue", value: peak, time: t0 });

    const ramps = calls.filter((c) => c.kind === "ramp");
    expect(ramps).toHaveLength(EQUAL_POWER_RAMP_STEPS);
    // Each ramp endpoint lands on the cosine curve at its fraction of the window.
    ramps.forEach((call, idx) => {
      const progress = (idx + 1) / EQUAL_POWER_RAMP_STEPS;
      expect(call.time).toBeCloseTo(t0 + duration * progress, 10);
      expect(call.value).toBeCloseTo(peak * Math.cos(progress * 0.5 * Math.PI), 10);
    });
    // Final endpoint is exactly silent.
    expect(ramps[ramps.length - 1]!.value).toBeCloseTo(0, 10);
  });

  test("incoming ramp starts at 0 and ends at peak", () => {
    const { param, calls } = fakeAudioParam();
    const peak = 1;
    scheduleEqualPowerRamp(param, 0, 5, peak, "in");
    expect(calls[1]).toEqual({ kind: "setValue", value: 0, time: 0 });
    const ramps = calls.filter((c) => c.kind === "ramp");
    expect(ramps[ramps.length - 1]!.value).toBeCloseTo(peak, 10);
  });

  test("muted fade (peak 0) stays at 0 throughout", () => {
    const { param, calls } = fakeAudioParam();
    scheduleEqualPowerRamp(param, 0, 4, 0, "in");
    for (const call of calls) {
      if (call.kind !== "cancel") expect(call.value).toBe(0);
    }
  });
});
