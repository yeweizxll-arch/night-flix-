# Admin frontend deployment modes

The same source tree produces two isolated administration sites. The mode is
fixed at build time and must match the domain where the output is deployed.

```bash
# Deploy this output to the independent platform administration subdomain.
VITE_ADMIN_SCOPE=platform pnpm --filter @drama/admin build

# Deploy this output to each merchant administration domain/subdomain.
VITE_ADMIN_SCOPE=tenant pnpm --filter @drama/admin build
```

`platform` is the default when `VITE_ADMIN_SCOPE` is omitted. Platform builds
only authenticate through `/api/v1/platform/auth/*`; tenant builds only use
`/api/v1/tenant/auth/*` and require the API to resolve the current verified
merchant domain. Build the two modes into separate deployment artifacts because
each build writes to `apps/admin/dist`.

Fake payment configuration is hidden by default. For local development only,
start Vite with `VITE_ENABLE_FAKE_PAYMENT=true`; the UI additionally checks that
the current build is not a production build. Never enable this switch on a
deployed administration site.
