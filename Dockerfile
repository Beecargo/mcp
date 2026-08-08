# Standalone image for https://github.com/Beecargo/mcp (also used from monorepo submodule).
# Build: docker build -t beecargo-mcp .
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY package.json ./
RUN pnpm install --no-frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build \
  && pnpm prune --prod

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV BEECARGO_MCP_TRANSPORT=http
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 3100
CMD ["node", "dist/http-entry.js"]
