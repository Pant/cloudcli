export const ACTIVITY_ACTION_ROTATION_SECONDS = 4;

export const getActivityLabel = (
  statusText: string | null,
  actionWords: readonly string[],
  elapsedSeconds: number,
): string => {
  const normalizedElapsedSeconds = Math.max(0, elapsedSeconds);
  const fallback = actionWords.length > 0
    ? actionWords[Math.floor(normalizedElapsedSeconds / ACTIVITY_ACTION_ROTATION_SECONDS) % actionWords.length]
    : '';

  return (statusText || fallback || '').replace(/\.+$/, '');
};

export const getElapsedTimeParts = (elapsedSeconds: number): { minutes: number; seconds: number } => {
  const normalizedElapsedSeconds = Math.max(0, Math.floor(elapsedSeconds));

  return {
    minutes: Math.floor(normalizedElapsedSeconds / 60),
    seconds: normalizedElapsedSeconds % 60,
  };
};
