# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY apps/h5/package.json apps/h5/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .

RUN pnpm --filter @drama/api build \
    && pnpm --filter @drama/api deploy --legacy --prod /output/api \
    && VITE_ADMIN_SCOPE=platform pnpm --filter @drama/admin build \
    && cp -R apps/admin/dist /output/platform-admin \
    && VITE_ADMIN_SCOPE=tenant pnpm --filter @drama/admin build \
    && cp -R apps/admin/dist /output/tenant-admin \
    && VITE_H5_RELEASE_CHANNEL=production pnpm --filter @drama/h5 build \
    && cp -R apps/h5/dist /output/h5

FROM node:24-bookworm-slim AS api

ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app/apps/api

RUN groupadd --system --gid 10001 drama \
    && useradd --system --uid 10001 --gid drama --home-dir /nonexistent drama

COPY --from=build --chown=drama:drama /output/api ./
COPY --from=build --chown=drama:drama /workspace/database /app/database

USER drama
EXPOSE 3000
CMD ["node", "dist/main.js"]

FROM nginx:1.27-alpine AS web

COPY deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /output/platform-admin /srv/platform-admin
COPY --from=build /output/tenant-admin /srv/tenant-admin
COPY --from=build /output/h5 /srv/h5

ENV STATIC_ROOT=/srv/h5
ENV API_ORIGIN=http://api:3000
ENV NGINX_ENVSUBST_FILTER=STATIC_ROOT|API_ORIGIN
EXPOSE 8080
