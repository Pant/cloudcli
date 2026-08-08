import assert from 'node:assert/strict';
import test from 'node:test';

import { createCapabilityRequest, loadLanguageExtensions } from './editorExtensions';

test('loads only the language requested by the filename', async () => {
  assert.equal((await loadLanguageExtensions('settings.env')).length, 1);
  assert.equal((await loadLanguageExtensions('.env.local')).length, 1);
  assert.deepEqual(await loadLanguageExtensions('README.unsupported'), []);
});

test('invalidates earlier capability requests during rapid switching', () => {
  const sequence = { current: 0 };
  const first = createCapabilityRequest(sequence);
  const second = createCapabilityRequest(sequence);

  assert.equal(first.isCurrent(), false);
  assert.equal(second.isCurrent(), true);
});
