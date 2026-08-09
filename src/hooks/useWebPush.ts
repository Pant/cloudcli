import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../utils/api';

export type WebPushOperationResult = { success: boolean };

type WebPushState = {
  permission: NotificationPermission | 'unsupported';
  isSubscribed: boolean;
  isLoading: boolean;
  subscribe: () => Promise<WebPushOperationResult>;
  unsubscribe: () => Promise<WebPushOperationResult>;
};

type PushDependencies = {
  fetch: typeof authenticatedFetch;
  registration: ServiceWorkerRegistration;
};

export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  if (!base64String.trim()) throw new Error('Missing VAPID public key');
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = globalThis.atob(base64);
  if (!rawData.length) throw new Error('Malformed VAPID public key');
  return Uint8Array.from(rawData, (character) => character.charCodeAt(0));
}

function arraysEqual(left: ArrayBuffer | null, right: Uint8Array): boolean {
  if (!left) return false;
  const bytes = new Uint8Array(left);
  return bytes.length === right.length && bytes.every((value, index) => value === right[index]);
}

async function getApplicationServerKey(fetch: typeof authenticatedFetch): Promise<Uint8Array> {
  const response = await fetch('/api/settings/push/vapid-public-key');
  if (!response.ok) throw new Error('Unable to load VAPID public key');
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || typeof (body as { publicKey?: unknown }).publicKey !== 'string') {
    throw new Error('Malformed VAPID public key response');
  }
  return urlBase64ToUint8Array((body as { publicKey: string }).publicKey);
}

async function registerSubscription(fetch: typeof authenticatedFetch, subscription: PushSubscription): Promise<void> {
  const subscriptionJson = subscription.toJSON();
  if (!subscriptionJson.endpoint || !subscriptionJson.keys?.p256dh || !subscriptionJson.keys.auth) {
    throw new Error('Malformed push subscription');
  }
  const response = await fetch('/api/settings/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({ endpoint: subscriptionJson.endpoint, keys: subscriptionJson.keys }),
  });
  if (!response.ok) throw new Error('Backend push registration failed');
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || (body as { success?: unknown }).success !== true) {
    throw new Error('Malformed backend push registration response');
  }
}

export async function ensureWebPushSubscription({ fetch, registration }: PushDependencies): Promise<PushSubscription> {
  const applicationServerKey = await getApplicationServerKey(fetch);
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !arraysEqual(subscription.options.applicationServerKey, applicationServerKey)) {
    if (!await subscription.unsubscribe()) throw new Error('Unable to replace stale push subscription');
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey.buffer as ArrayBuffer,
  });
  await registerSubscription(fetch, subscription);
  return subscription;
}

export async function removeWebPushSubscription({ fetch, registration }: PushDependencies): Promise<boolean> {
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return true;
  if (!await subscription.unsubscribe()) return false;
  const response = await fetch('/api/settings/push/unsubscribe', {
    method: 'POST',
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  if (!response.ok) return false;
  const body: unknown = await response.json();
  return Boolean(body && typeof body === 'object' && (body as { success?: unknown }).success === true);
}

export function useWebPush(): WebPushState {
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() => {
    if (typeof window === 'undefined' || Boolean((window as any).cloudcliDesktopNotifications)
      || !('Notification' in window) || !('serviceWorker' in navigator)) return 'unsupported';
    return Notification.permission;
  });
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (permission !== 'granted') return;
    let active = true;
    void navigator.serviceWorker.ready.then(async (registration) => {
      try {
        await ensureWebPushSubscription({ fetch: authenticatedFetch, registration });
        if (active) setIsSubscribed(true);
      } catch (error) {
        console.error('Push subscription reconciliation failed:', error);
        if (active) setIsSubscribed(false);
      }
    }).catch((error) => {
      console.error('Service worker readiness failed:', error);
      if (active) setIsSubscribed(false);
    });
    return () => { active = false; };
  }, [permission]);

  const subscribe = useCallback(async (): Promise<WebPushOperationResult> => {
    if (permission === 'unsupported') return { success: false };
    setIsLoading(true);
    try {
      const nextPermission = await Notification.requestPermission();
      setPermission(nextPermission);
      if (nextPermission !== 'granted') {
        setIsSubscribed(false);
        return { success: false };
      }
      const registration = await navigator.serviceWorker.ready;
      await ensureWebPushSubscription({ fetch: authenticatedFetch, registration });
      setIsSubscribed(true);
      return { success: true };
    } catch (error) {
      console.error('Push subscribe failed:', error);
      setIsSubscribed(false);
      return { success: false };
    } finally {
      setIsLoading(false);
    }
  }, [permission]);

  const unsubscribe = useCallback(async (): Promise<WebPushOperationResult> => {
    if (permission === 'unsupported') return { success: false };
    setIsLoading(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const success = await removeWebPushSubscription({ fetch: authenticatedFetch, registration });
      setIsSubscribed(Boolean(await registration.pushManager.getSubscription()));
      return { success };
    } catch (error) {
      console.error('Push unsubscribe failed:', error);
      return { success: false };
    } finally {
      setIsLoading(false);
    }
  }, [permission]);

  return { permission, isSubscribed, isLoading, subscribe, unsubscribe };
}
