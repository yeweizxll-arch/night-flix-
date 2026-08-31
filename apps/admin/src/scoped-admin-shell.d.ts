declare module '@admin-scope-shell' {
  import type { ReactElement } from 'react';
  import type { AuthPrincipal } from './auth/AuthProvider';

  export function ScopedAdminShell(props: {
    principal: AuthPrincipal;
  }): ReactElement;
}
