# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src src
RUN npx tsc -p tsconfig.build.json && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY package.json ./
USER node
EXPOSE 8080
# The same image runs the cloud service (default) or an edge gateway: `node dist/service/edgeMain.js`.
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/service/main.js"]
