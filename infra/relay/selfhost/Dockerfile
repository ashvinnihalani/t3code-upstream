# Self-hosted T3 Connect relay. Build from the repository root:
#   docker build -f infra/relay/selfhost/Dockerfile -t t3code-relay .
FROM node:26.12.1-bookworm-slim

RUN npm install --global pnpm@12.14.0
WORKDIR /app
COPY . .
# The relay runs its TypeScript sources directly; no build step.
RUN pnpm install --frozen-lockfile --filter "t3code-relay..." --ignore-scripts

USER node
ENV NODE_ENV=production
EXPOSE 8787 8788
CMD ["node", "infra/relay/src/selfhost/main.ts"]
