// Equal-power (constant-power) crossfade curve.
//
// Two different songs are uncorrelated signals, so their combined loudness during
// an overlap tracks the sum of *powers* (amplitude²), not the sum of amplitudes.
// A straight linear fade leaves each track at half amplitude at the midpoint, so
// the combined power is 0.5² + 0.5² = 0.5 (≈ -3 dB) — an audible loudness dip right
// in the middle of the transition. Fading the outgoing track along cos() and the
// incoming track along sin() keeps cos²+sin²=1 at every point, so the perceived
// volume stays flat across the whole crossfade. This is the curve Audacity, pro
// DAWs, and the Web Audio API guide prescribe for music crossfades.

/**
 * Gain multiplier (0..1) at a given progress through the fade.
 * @param progress 0 at the start of the fade, 1 at the end (clamped).
 * @param direction "out" for the outgoing track (1 → 0), "in" for the incoming (0 → 1).
 */
export function equalPowerGain(progress: number, direction: "in" | "out"): number {
  const clamped = progress <= 0 ? 0 : progress >= 1 ? 1 : progress;
  return direction === "out"
    ? Math.cos(clamped * 0.5 * Math.PI)
    : Math.sin(clamped * 0.5 * Math.PI);
}

// Number of linear segments used to trace the curve on a Web Audio AudioParam.
// 24 steps over a multi-second fade is aurally indistinguishable from a true cosine.
export const EQUAL_POWER_RAMP_STEPS = 24;

/**
 * Schedule an equal-power ramp on a GainNode's AudioParam as a chain of short
 * linear segments (one `setValueAtTime` anchor + N `linearRampToValueAtTime`).
 *
 * Piecewise-linear is deliberate rather than `setValueCurveAtTime`: the crossfade's
 * cancel/commit path interrupts a running ramp with `cancelScheduledValues` +
 * `setValueAtTime`, and several browsers throw if that lands inside an active value
 * curve — but it overrides linear ramps cleanly.
 *
 * @param param    the GainNode's `.gain` AudioParam.
 * @param startTime AudioContext time at which the fade begins.
 * @param duration  fade length in seconds.
 * @param peak      the full output level (the target volume) the curve scales to.
 * @param direction "out" ramps peak → 0, "in" ramps 0 → peak.
 */
export function scheduleEqualPowerRamp(
  param: AudioParam,
  startTime: number,
  duration: number,
  peak: number,
  direction: "in" | "out",
): void {
  param.cancelScheduledValues(startTime);
  param.setValueAtTime(peak * equalPowerGain(0, direction), startTime);
  for (let i = 1; i <= EQUAL_POWER_RAMP_STEPS; i += 1) {
    const progress = i / EQUAL_POWER_RAMP_STEPS;
    param.linearRampToValueAtTime(
      peak * equalPowerGain(progress, direction),
      startTime + duration * progress,
    );
  }
}
