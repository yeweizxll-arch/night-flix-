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
  const sessionEpoch = useRef(0);

  const updateSession = useCallback((value: SessionResponse | undefined) => {
    if (value?.principal.id !== sessionRef.current?.principal.id ||
        value?.principal.tenantId !== sessionRef.current?.principal.tenantId) {
      sessionEpoch.current++;
    }
    sessionRef.current = value;
    setSession(value);
  }, []);

  const refreshSession = useCallback((): Promise<SessionResponse> => {
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current;
    }
    const epoch = sessionEpoch.current;
    const operation = requestJson<SessionResponse>(
      `${AUTH_API_BASE}/refresh`,
      { method: 'POST' },
    )
      .then((result) => validateSessionScope(result))
      .then((result) => {
        if (epoch !== sessionEpoch.current) throw new ApiError('登录状态已变更', 401);
        updateSession(result);
        return result;
      })
      .finally(() => {
        if (refreshPromiseRef.current === operation) refreshPromiseRef.current = undefined;
      });
    refreshPromiseRef.current = operation;
    return operation;
  }, [updateSession]);

  useEffect(() => {
    const epoch = sessionEpoch.current;
    void refreshSession()
      .catch(() => { if (epoch === sessionEpoch.current) updateSession(undefined); })
      .finally(() => setLoading(false));
  }, [refreshSession, updateSession]);

  const login = useCallback(async (username: string, password: string) => {
    const epoch = ++sessionEpoch.current;
    refreshPromiseRef.current = undefined;
    const result = await requestJson<SessionResponse>(`${AUTH_API_BASE}/login`, {
      body: JSON.stringify({ password, username }),
      method: 'POST',
    });
    if (epoch === sessionEpoch.current) updateSession(validateSessionScope(result));
  }, [updateSession]);

  const request = useCallback(
    async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
      const current = sessionRef.current;
      const epoch = sessionEpoch.current;
      if (!current) {
        throw new ApiError('登录状态已失效', 401);
      }
      const preparedInit = withIdempotencyKey(init);
      try {
        const result = await requestJson<T>(path, preparedInit, current.accessToken);
        if (epoch !== sessionEpoch.current) throw new ApiError('登录状态已变更', 401);
        return result;
      } catch (error) {
        if (epoch !== sessionEpoch.current) throw new ApiError('登录状态已变更', 401);
        if (!(error instanceof ApiError) || error.status !== 401) {
          throw error;
        }
        let renewed: SessionResponse;
        try {
          renewed = sessionRef.current && sessionRef.current.accessToken !== current.accessToken
            ? sessionRef.current : await refreshSession();
        } catch (refreshError) {
          if (epoch === sessionEpoch.current) updateSession(undefined);
          throw refreshError;
        }
        // A business error after renewal must not discard the valid login.
        if (epoch !== sessionEpoch.current) throw new ApiError('登录状态已变更', 401);
        const result = await requestJson<T>(path, preparedInit, renewed.accessToken);
        if (epoch !== sessionEpoch.current) throw new ApiError('登录状态已变更', 401);
        return result;
      }
    },
    [refreshSession, updateSession],
  );

  const logout = useCallback(async () => {
    const epoch = ++sessionEpoch.current;
    refreshPromiseRef.current = undefined;
    await requestJson<void>(
      `${AUTH_API_BASE}/logout`,
      { method: 'POST' },
      session?.accessToken,
    );
    if (epoch === sessionEpoch.current) updateSession(undefined);
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
