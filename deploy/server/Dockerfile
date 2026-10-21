# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM node:22-alpine AS build-dependencies
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY pnpm-lock.yaml ./
RUN --mount=type=cache,id=termrelay-pnpm,target=/pnpm/store,sharing=locked \
    pnpm --filter @termrelay/server... --filter @termrelay/web... install --frozen-lockfile --store-dir /pnpm/store

FROM build-dependencies AS contracts-build
COPY packages/contracts packages/contracts
RUN pnpm --filter @termrelay/contracts build

FROM contracts-build AS server-build
COPY apps/server/tsconfig*.json apps/server/nest-cli.json apps/server/
COPY apps/server/src apps/server/src
RUN pnpm --filter @termrelay/server exec nest build --path tsconfig.release.json

FROM contracts-build AS web-build
COPY apps/web apps/web
RUN pnpm --filter @termrelay/web build

FROM node:22-alpine AS production-dependencies
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/server/package.json apps/server/package.json
COPY --from=contracts-build /workspace/packages/contracts/dist packages/contracts/dist
RUN --mount=type=cache,id=termrelay-pnpm,target=/pnpm/store,sharing=locked \
    pnpm --filter @termrelay/server deploy --prod --frozen-lockfile --store-dir /pnpm/store /output

FROM node:22-alpine AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
RUN addgroup -S termrelay && adduser -S termrelay -G termrelay
COPY --from=production-dependencies --chown=termrelay:termrelay /output ./
COPY --from=server-build --chown=termrelay:termrelay /workspace/apps/server/dist ./dist
COPY --from=web-build --chown=termrelay:termrelay /workspace/apps/server/dist/public ./dist/public
USER termrelay
EXPOSE 3000
CMD ["node", "dist/main.js"]
