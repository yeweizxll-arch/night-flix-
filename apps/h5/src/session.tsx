import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { createBrowserCustomerApi, type CustomerApiClient } from './api/client';
import type { CustomerPrincipal } from './api/types';

interface SessionValue {
  api: CustomerApiClient;
  initializing: boolean;
  login: (identifier: string, password: string) => Promise<CustomerPrincipal>;
  logout: () => Promise<void>;
  principal?: CustomerPrincipal;
}

const SessionContext = createContext<SessionValue | undefined>(undefined);

export function SessionProvider({ children }: { children: ReactNode }) {
  const api = useMemo(createBrowserCustomerApi, []);
  const [principal, setPrincipal] = useState(api.currentPrincipal());
  const [initializing, setInitializing] = useState(true);

  useEffect(() => api.subscribe(setPrincipal), [api]);
  useEffect(() => {
    let live = true;
    void api.restore().finally(() => { if (live) setInitializing(false); });
    return () => { live = false; };
  }, [api]);

  const value = useMemo<SessionValue>(() => ({
    api,
    initializing,
    login: (identifier, password) => api.login(identifier, password),
    logout: () => api.logout(),
    principal,
  }), [api, initializing, principal]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('SessionProvider is required');
  return value;
}
