// Utilities for PWA: wake-lock, visibility handling, online/offline, reconnect

let wakeLock: WakeLockSentinel | null = null;

/**
 * Request a screen wake-lock to prevent the screen from turning off
 * while the terminal is active. Only works in secure contexts (HTTPS).
 */
export async function requestWakeLock(): Promise<void> {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    }
  } catch {
    // Wake lock not available or denied — not critical
  }
}

/**
 * Release the screen wake-lock.
 */
export async function releaseWakeLock(): Promise<void> {
  try {
    if (wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    // Ignore
  }
}

/**
 * Re-request wake-lock after visibility change (page becomes visible again).
 * Wake-locks are automatically released when the page is hidden.
 */
export function setupWakeLockRecovery(): () => void {
  const handler = async () => {
    if (document.visibilityState === 'visible' && wakeLock === null) {
      await requestWakeLock();
    }
  };
  document.addEventListener('visibilitychange', handler);
  return () => document.removeEventListener('visibilitychange', handler);
}

/**
 * Check if the browser is currently online.
 */
export function isOnline(): boolean {
  return navigator.onLine;
}

/**
 * Subscribe to online/offline events. Returns unsubscribe function.
 */
export function onConnectionChange(callback: (online: boolean) => void): () => void {
  const online = () => callback(true);
  const offline = () => callback(false);
  window.addEventListener('online', online);
  window.addEventListener('offline', offline);
  return () => {
    window.removeEventListener('online', online);
    window.removeEventListener('offline', offline);
  };
}

/**
 * Subscribe to visibility change events. Returns unsubscribe function.
 * Useful for reconnecting WebSocket when the page becomes visible again.
 */
export function onVisibilityChange(callback: (visible: boolean) => void): () => void {
  const handler = () => {
    callback(document.visibilityState === 'visible');
  };
  document.addEventListener('visibilitychange', handler);
  return () => document.removeEventListener('visibilitychange', handler);
}

/**
 * Exponential backoff calculator for reconnection attempts.
 */
export function calculateBackoff(attempt: number, baseMs = 1000, maxMs = 30000): number {
  const delay = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  // Add jitter: random value between 0 and 50% of the delay
  return delay + Math.random() * delay * 0.5;
}