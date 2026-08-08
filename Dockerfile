# Build from repo root: docker build -f apps/mcp/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/mcp/package.json ./apps/mcp/
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @beecargo/mcp...
COPY apps/mcp ./apps/mcp
RUN pnpm --filter @beecargo/mcp build \
  && pnpm --filter @beecargo/mcp deploy --prod /app/deploy

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV BEECARGO_MCP_TRANSPORT=http
COPY --from=build /app/deploy ./
EXPOSE 3100
CMD ["node", "dist/http-entry.js"]
