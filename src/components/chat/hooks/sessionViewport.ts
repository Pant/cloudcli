export const VIEWPORT_BOTTOM_THRESHOLD = 50;

export type SavedViewport =
  | { mode: 'bottom'; bottomDistance: number }
  | { mode: 'anchor'; key: string; offset: number };

export interface ViewportMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function distanceFromBottom(metrics: ViewportMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight);
}

export function isViewportNearBottom(metrics: ViewportMetrics): boolean {
  return distanceFromBottom(metrics) < VIEWPORT_BOTTOM_THRESHOLD;
}

export function chooseViewportSnapshot(
  metrics: ViewportMetrics,
  anchor: { key: string; offset: number } | null,
): SavedViewport {
  return isViewportNearBottom(metrics)
    ? { mode: 'bottom', bottomDistance: distanceFromBottom(metrics) }
    : anchor
      ? { mode: 'anchor', ...anchor }
      : { mode: 'bottom', bottomDistance: distanceFromBottom(metrics) };
}

export function shouldPinViewport(options: {
  saved: SavedViewport | null;
  searchActive: boolean;
  firstOpen: boolean;
}): boolean {
  return !options.searchActive && (options.firstOpen || options.saved?.mode === 'bottom');
}

export function transitionViewportOwnership(options: {
  departingIdentityKey: string | null;
  arrivingIdentityKey: string | null;
  departingViewport: SavedViewport | null;
  savedViewports: ReadonlyMap<string, SavedViewport>;
}): { save: { key: string; viewport: SavedViewport } | null; restore: SavedViewport | null; firstOpen: boolean } {
  const save = options.departingIdentityKey && options.departingViewport
    ? { key: options.departingIdentityKey, viewport: options.departingViewport }
    : null;
  const restore = options.arrivingIdentityKey
    ? options.savedViewports.get(options.arrivingIdentityKey) ?? null
    : null;
  return { save, restore, firstOpen: options.arrivingIdentityKey !== null && restore === null };
}

export function shouldCancelViewportSettle(options: {
  userIntent: boolean;
  applyingAutomaticScroll: boolean;
}): boolean {
  return options.userIntent && !options.applyingAutomaticScroll;
}

export const VIEWPORT_SETTLE_MAX_FRAMES = 60;
export const VIEWPORT_SETTLE_STABLE_FRAMES = 3;

export interface ViewportSettleState {
  frame: number;
  stableFrames: number;
  lastMeasurement: number | null;
}

export function advanceViewportSettle(
  state: ViewportSettleState,
  measurement: number,
): { state: ViewportSettleState; done: boolean } {
  const stableFrames = state.lastMeasurement === measurement ? state.stableFrames + 1 : 0;
  const next = { frame: state.frame + 1, stableFrames, lastMeasurement: measurement };
  return {
    state: next,
    done: next.stableFrames >= VIEWPORT_SETTLE_STABLE_FRAMES || next.frame >= VIEWPORT_SETTLE_MAX_FRAMES,
  };
}

export function isSelectionCurrent(expected: string | null, current: string | null): boolean {
  return expected !== null && expected === current;
}

export function shouldApplyViewportRevision(options: {
  expectedIdentityKey: string | null;
  currentIdentityKey: string | null;
  previousRevision: number;
  nextRevision: number;
  searchActive: boolean;
}): boolean {
  return isSelectionCurrent(options.expectedIdentityKey, options.currentIdentityKey)
    && options.previousRevision !== options.nextRevision
    && !options.searchActive;
}
