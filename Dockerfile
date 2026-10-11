FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production DATABASE_PATH=/app/data/bot.sqlite
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node THIRD_PARTY_NOTICES.md ./
RUN mkdir -p /app/data && chown node:node /app/data
USER node
CMD ["node", "dist/index.js"]
