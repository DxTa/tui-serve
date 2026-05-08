import { useEffect, useState } from 'react';
import { api } from '../lib/apiClient';
import { getAuthToken, hasAuthToken, isAuthRequired, setAuthRequired } from '../lib/auth';

export function useAuthProbe() {
  const [authed, setAuthed] = useState(hasAuthToken() || !isAuthRequired());
  const [token, setToken] = useState(getAuthToken() || '');
  const [authError, setAuthError] = useState('');
  const [checkingAuth, setCheckingAuth] = useState(true);

  useEffect(() => {
    const probeAuth = async () => {
      try {
        const health = await api.health();
        setAuthRequired(health.authRequired ?? false);
        if (!health.authRequired || hasAuthToken()) {
          setAuthed(true);
        }
      } catch {
        // Fallback to auth screen if server cannot be reached.
      } finally {
        setCheckingAuth(false);
      }
    };
    probeAuth();
  }, []);

  return {
    authed,
    setAuthed,
    token,
    setToken,
    authError,
    setAuthError,
    checkingAuth,
  };
}
