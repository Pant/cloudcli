export type PwaRegistrationSnapshot = {
  registration: ServiceWorkerRegistration | null;
  waiting: ServiceWorker | null;
};

type Listener = (snapshot: PwaRegistrationSnapshot) => void;
const listeners = new Set<Listener>();
let snapshot: PwaRegistrationSnapshot = { registration: null, waiting: null };
let initialization: Promise<ServiceWorkerRegistration | null> | null = null;

type RegistrationEnvironment = {
  production: boolean;
  serviceWorker: ServiceWorkerContainer;
  window: Window;
  baseUrl: () => URL;
};

function publish(next: Partial<PwaRegistrationSnapshot>) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach(listener => listener(snapshot));
}

export function getPwaBaseUrl(documentBase = document.baseURI) {
  const manifest = document.querySelector('link[rel="manifest"]')?.getAttribute('href') || './manifest.json';
  return new URL('.', new URL(manifest, documentBase));
}

export function subscribeToPwaRegistration(listener: Listener) {
  listeners.add(listener);
  listener(snapshot);
  return () => { listeners.delete(listener); };
}

export function activateWaitingServiceWorker() {
  snapshot.waiting?.postMessage({ type: 'cloudcli:activate-update' });
}

export function checkForPwaUpdate() {
  return snapshot.registration?.update().then(() => undefined) ?? Promise.resolve();
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
        publish({ registration, waiting: registration.waiting });
        registration.addEventListener('updatefound', () => registration.installing?.addEventListener('statechange', () => {
          if (registration.waiting) publish({ waiting: registration.waiting });
        }));
        void registration.update().catch(error => console.warn('Service worker update check failed:', error));
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
