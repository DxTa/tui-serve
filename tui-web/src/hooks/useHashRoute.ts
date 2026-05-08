import { useEffect, useState } from 'react';

function getSessionIdFromHash(): string | null {
  const hash = window.location.hash.replace('#', '');
  return hash.startsWith('/s/') ? hash.substring(3) : null;
}

export function setHash(hash: string): void {
  window.location.hash = hash;
}

export function useHashRoute() {
  const [sessionId, setSessionId] = useState<string | null>(() => getSessionIdFromHash());

  useEffect(() => {
    const handleHashChange = () => setSessionId(getSessionIdFromHash());
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  return {
    sessionId,
    view: sessionId ? 'terminal' as const : 'dashboard' as const,
    setHash,
  };
}
