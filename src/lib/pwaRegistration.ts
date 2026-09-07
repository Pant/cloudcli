let initialization: Promise<ServiceWorkerRegistration | null> | null = null;

type RegistrationEnvironment = {
  production: boolean;
  serviceWorker: ServiceWorkerContainer;
  window: Window;
  baseUrl: () => URL;
};

export function getPwaBaseUrl(documentBase = document.baseURI, manifestHref?: string) {
  const manifest = manifestHref
    ?? document.querySelector('link[rel="manifest"]')?.getAttribute('href')
    ?? new URL('/manifest.json', documentBase).href;
  return new URL('.', new URL(manifest, documentBase));
}

export function createPwaRegistrationController(environment: RegistrationEnvironment) {
  return async () => {
    if (!environment.production) {
      const registrations = await environment.serviceWorker.getRegistrations();
      await Promise.all(registrations.filter(registration => registration.active?.scriptURL.endsWith('/sw.js')).map(registration => registration.unregister()));
      return null;
    }
    return new Promise<ServiceWorkerRegistration | null>(resolve => environment.window.addEventListener('load', async () => {
      try {
        const base = environment.baseUrl();
        const registration = await environment.serviceWorker.register(new URL('sw.js', base), { scope: base.pathname, updateViaCache: 'none' });
        resolve(registration);
      } catch (error) {
        console.warn('Service worker registration failed:', error);
        resolve(null);
      }
    }, { once: true }));
  };
}

export function initializePwaRegistration() {
  if (initialization) return initialization;
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  initialization = createPwaRegistrationController({
    production: import.meta.env.PROD,
    serviceWorker: navigator.serviceWorker,
    window,
    baseUrl: () => getPwaBaseUrl(),
  })();
  return initialization;
}
