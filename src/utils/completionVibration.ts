export const COMPLETION_VIBRATION_PATTERN = [200, 100, 200] as const;

export const vibrateForCompletion = (): void => {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') {
    return;
  }

  try {
    navigator.vibrate([...COMPLETION_VIBRATION_PATTERN]);
  } catch {
    // Vibration is optional and may be unavailable despite feature detection.
  }
};
