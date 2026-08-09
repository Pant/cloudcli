import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { vibrateForCompletion } from './completionVibration';

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

const setNavigator = (value: object): void => {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value });
};

afterEach(() => {
  if (originalNavigator) {
    Object.defineProperty(globalThis, 'navigator', originalNavigator);
  } else {
    Reflect.deleteProperty(globalThis, 'navigator');
  }
});

describe('vibrateForCompletion', () => {
  it('invokes supported vibration with the completion pattern', () => {
    let receivedPattern: number[] | undefined;
    setNavigator({ vibrate: (pattern: number[]) => {
      receivedPattern = pattern;
      return true;
    } });

    vibrateForCompletion();

    assert.deepEqual(receivedPattern, [200, 100, 200]);
  });

  it('does nothing when vibration is unsupported', () => {
    setNavigator({});
    assert.doesNotThrow(() => vibrateForCompletion());
  });

  it('does not treat a false return as an error', () => {
    setNavigator({ vibrate: () => false });
    assert.doesNotThrow(() => vibrateForCompletion());
  });

  it('degrades without throwing when vibration throws', () => {
    setNavigator({ vibrate: () => { throw new Error('unsupported'); } });
    assert.doesNotThrow(() => vibrateForCompletion());
  });
});
