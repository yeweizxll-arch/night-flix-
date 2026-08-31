import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { ApiError, requestJson } from '../api/http';
import { ADMIN_SCOPE, AUTH_API_BASE, type AdminScope } from '../config/admin-scope';

export interface AuthPrincipal {
  id: string;
  displayName: string;
  scope: 'platform' | 'tenant';
  tenantId?: string;
  permissions: string[];
}

interface SessionResponse {
  accessToken: string;
  accessExpiresAt: string;
  principal: AuthPrincipal;
}

interface AuthContextValue {
  adminScope: AdminScope;
  loading: boolean;
  principal?: AuthPrincipal;
  request<T>(path: string, init?: RequestInit): Promise<T>;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<SessionResponse>();
  const [loading, setLoading] = useState(true);
  const sessionRef = useRef<SessionResponse | undefined>(undefined);
  const refreshPromiseRef = useRef<Promise<SessionResponse> | undefined>(undefined);

  const updateSession = useCallback((value: SessionResponse | undefined) => {
    sessionRef.current = value;
    setSession(value);
  }, []);

  const refreshSession = useCallback((): Promise<SessionResponse> => {
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current;
    }
    const operation = requestJson<SessionResponse>(
      `${AUTH_API_BASE}/refresh`,
      { method: 'POST' },
    )
      .then((result) => validateSessionScope(result))
      .then((result) => {
        updateSession(result);
        return result;
      })
      .finally(() => {
        refreshPromiseRef.current = undefined;
      });
    refreshPromiseRef.current = operation;
    return operation;
  }, [updateSession]);

  useEffect(() => {
    void refreshSession()
      .catch(() => updateSession(undefined))
      .finally(() => setLoading(false));
  }, [refreshSession, updateSession]);

  const login = useCallback(async (username: string, password: string) => {
    const result = await requestJson<SessionResponse>(`${AUTH_API_BASE}/login`, {
      body: JSON.stringify({ password, username }),
      method: 'POST',
    });
    updateSession(validateSessionScope(result));
  }, [updateSession]);

  const request = useCallback(
    async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
      const current = sessionRef.current;
      if (!current) {
        throw new ApiError('登录状态已失效', 401);
      }
      const preparedInit = withIdempotencyKey(init);
      try {
        return await requestJson<T>(path, preparedInit, current.accessToken);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) {
          throw error;
        }
        try {
          const renewed = await refreshSession();
          return await requestJson<T>(path, preparedInit, renewed.accessToken);
        } catch (refreshError) {
          updateSession(undefined);
          throw refreshError;
        }
      }
    },
    [refreshSession, updateSession],
  );

  const logout = useCallback(async () => {
    try {
      await requestJson<void>(
        `${AUTH_API_BASE}/logout`,
        { method: 'POST' },
        session?.accessToken,
      );
    } finally {
      updateSession(undefined);
    }
  }, [session?.accessToken, updateSession]);

  const value = useMemo<AuthContextValue>(
    () => ({ adminScope: ADMIN_SCOPE, loading, login, logout, principal: session?.principal, request }),
    [loading, login, logout, request, session?.principal],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function withIdempotencyKey(init: RequestInit): RequestInit {
  const method = (init.method ?? 'GET').toUpperCase();
  if (!['DELETE', 'PATCH', 'POST', 'PUT'].includes(method)) return init;
  const headers = new Headers(init.headers);
  if (!headers.has('Idempotency-Key')) {
    headers.set('Idempotency-Key', crypto.randomUUID());
  }
  return { ...init, headers };
}

function validateSessionScope(session: SessionResponse): SessionResponse {
  if (
    session.principal.scope !== ADMIN_SCOPE ||
    (ADMIN_SCOPE === 'tenant' && !session.principal.tenantId) ||
    (ADMIN_SCOPE === 'platform' && session.principal.tenantId !== undefined)
  ) {
    throw new ApiError('登录账号与当前后台不匹配', 403, 'SCOPE_MISMATCH');
  }
  return session;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used inside AuthProvider');
  }

  return value;
}
