import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { getLanguageValues } from './languages.js';

const localeRoot = new URL('./locales/', import.meta.url);
const expectedNamespaces = ['auth', 'chat', 'codeEditor', 'common', 'settings', 'sidebar', 'tasks'];

test('every selectable language, including French, has every lazy namespace', async () => {
  const languages = getLanguageValues();
  assert.ok(languages.includes('fr'));

  for (const language of languages) {
    const files = await readdir(new URL(`${language}/`, localeRoot));
    assert.deepEqual(files.sort(), expectedNamespaces.map((namespace) => `${namespace}.json`).sort());

    for (const file of files) {
      const resource = JSON.parse(await readFile(new URL(`${language}/${file}`, localeRoot), 'utf8'));
      assert.equal(typeof resource, 'object');
      assert.ok(resource !== null && !Array.isArray(resource));
    }
  }
});

test('i18n config uses lazy locale imports and startup fallback preloading', async () => {
  const source = await readFile(new URL('./config.js', import.meta.url), 'utf8');

  assert.match(source, /import\.meta\.glob\('\.\/locales\/\*\/\*\.json'\)/);
  assert.match(source, /preload:\s*getStartupLanguages\(language\)/);
  assert.match(source, /fallbackLng:\s*FALLBACK_LANGUAGE/);
  assert.doesNotMatch(source, /from ['"]\.\/locales\//);
});
