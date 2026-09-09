# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY packages/contracts packages/contracts
COPY apps/server apps/server
COPY apps/web apps/web
RUN pnpm --filter @termrelay/contracts build \
 && pnpm --filter @termrelay/server build \
 && pnpm --filter @termrelay/web build \
 && pnpm --filter @termrelay/server deploy --prod /output
RUN cp -R apps/server/dist /output/dist

FROM node:22-alpine AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
RUN addgroup -S termrelay && adduser -S termrelay -G termrelay
COPY --from=build --chown=termrelay:termrelay /output ./
USER termrelay
EXPOSE 3000
CMD ["node", "dist/main.js"]
