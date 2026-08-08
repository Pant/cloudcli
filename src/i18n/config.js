/** Lazy i18n initialization and namespace loading. */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { getLanguageValues, isLanguageSupported } from './languages.js';

export const FALLBACK_LANGUAGE = 'en';
export const STARTUP_NAMESPACES = ['common', 'auth', 'sidebar'];
export const FEATURE_NAMESPACES = ['settings', 'chat', 'codeEditor', 'tasks'];

const localeModules = import.meta.glob('./locales/*/*.json');
const pendingResources = new Map();

export function getSavedLanguage(storage = globalThis.localStorage) {
  try {
    const saved = storage?.getItem('userLanguage');
    return saved && isLanguageSupported(saved) ? saved : FALLBACK_LANGUAGE;
  } catch {
    return FALLBACK_LANGUAGE;
  }
}

export function getStartupLanguages(language) {
  return language === FALLBACK_LANGUAGE ? [FALLBACK_LANGUAGE] : [language, FALLBACK_LANGUAGE];
}

export async function loadNamespace(language, namespace) {
  if (!isLanguageSupported(language)) {
    throw new Error(`Unsupported language: ${language}`);
  }

  const path = `./locales/${language}/${namespace}.json`;
  const importer = localeModules[path];
  if (!importer) {
    throw new Error(`Missing translation resource: ${language}/${namespace}`);
  }

  const resourceKey = `${language}:${namespace}`;
  if (!pendingResources.has(resourceKey)) {
    pendingResources.set(resourceKey, importer().then((module) => module.default));
  }
  return pendingResources.get(resourceKey);
}

const backend = {
  type: 'backend',
  read(language, namespace, callback) {
    loadNamespace(language, namespace).then(
      (resource) => callback(null, resource),
      (error) => callback(error, false),
    );
  },
};

let initialization;

export function initializeI18n() {
  if (initialization) return initialization;

  const language = getSavedLanguage();
  initialization = i18n
    .use(backend)
    .use(initReactI18next)
    .init({
      lng: language,
      fallbackLng: FALLBACK_LANGUAGE,
      supportedLngs: getLanguageValues(),
      nonExplicitSupportedLngs: false,
      debug: false,
      ns: STARTUP_NAMESPACES,
      defaultNS: 'common',
      fallbackNS: 'common',
      partialBundledLanguages: true,
      keySeparator: '.',
      nsSeparator: ':',
      saveMissing: false,
      interpolation: { escapeValue: false },
      preload: getStartupLanguages(language),
      react: {
        useSuspense: true,
        bindI18n: 'languageChanged',
        bindI18nStore: 'added',
      },
    })
    .then(() => i18n);

  i18n.on('languageChanged', (nextLanguage) => {
    try {
      localStorage.setItem('userLanguage', nextLanguage);
    } catch (error) {
      console.error('Failed to save language preference:', error);
    }
  });

  return initialization;
}

export function loadFeatureNamespaces(namespaces) {
  const requestedNamespaces = Array.isArray(namespaces) ? namespaces : [namespaces];
  return initializeI18n().then(() => i18n.loadNamespaces(requestedNamespaces));
}

export default i18n;
