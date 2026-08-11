export const LARGE_TRANSCRIPT_THRESHOLD = 100;
export const WINDOW_OVERSCAN_PX = 800;
export const DEFAULT_ROW_HEIGHT = 120;

export type MeasuredWindow = { start: number; end: number; before: number; after: number };

export function calculateMeasuredWindow(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  heights: ReadonlyMap<number, number>,
  targetIndex: number | null = null,
): MeasuredWindow {
  if (rowCount <= LARGE_TRANSCRIPT_THRESHOLD) return { start: 0, end: rowCount, before: 0, after: 0 };
  const offsets = new Array<number>(rowCount + 1);
  offsets[0] = 0;
  for (let index = 0; index < rowCount; index += 1) offsets[index + 1] = offsets[index] + (heights.get(index) ?? DEFAULT_ROW_HEIGHT);
  const targetTop = targetIndex !== null && targetIndex >= 0 && targetIndex < rowCount
    ? Math.max(0, offsets[targetIndex] - Math.max(0, viewportHeight - (heights.get(targetIndex) ?? DEFAULT_ROW_HEIGHT)) / 2)
    : scrollTop;
  const lower = Math.max(0, targetTop - WINDOW_OVERSCAN_PX);
  const upper = targetTop + viewportHeight + WINDOW_OVERSCAN_PX;
  let start = 0;
  while (start < rowCount && offsets[start + 1] < lower) start += 1;
  let end = start;
  while (end < rowCount && offsets[end] < upper) end += 1;
  return { start, end, before: offsets[start], after: offsets[rowCount] - offsets[end] };
}

export function compensateMeasuredGrowth(options: {
  rowIndex: number;
  windowStart: number;
  previousHeight: number | undefined;
  nextHeight: number;
  scrollTop: number;
  followingBottom: boolean;
}): number {
  if (options.previousHeight === undefined || options.previousHeight === options.nextHeight) return options.scrollTop;
  return options.rowIndex < options.windowStart || options.followingBottom
    ? Math.max(0, options.scrollTop + options.nextHeight - options.previousHeight)
    : options.scrollTop;
}

export function accessibleWindowPositions(window: MeasuredWindow, rowCount: number): Array<{ index: number; position: number; size: number }> {
  return Array.from({ length: window.end - window.start }, (_, offset) => ({
    index: window.start + offset,
    position: window.start + offset + 1,
    size: rowCount,
  }));
}

export function keyboardWindowTarget(currentIndex: number, key: string, rowCount: number): number | null {
  if (rowCount <= 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return rowCount - 1;
  if (key === 'ArrowUp') return Math.max(0, currentIndex - 1);
  if (key === 'ArrowDown') return Math.min(rowCount - 1, currentIndex + 1);
  return null;
}
