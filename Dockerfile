FROM node:22.13.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/bff/package.json apps/bff/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY . .
RUN npm run build

FROM node:22.13.0-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/bff/package.json apps/bff/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/migrations apps/api/migrations
COPY --from=build /app/apps/bff/dist apps/bff/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY scripts/start-production.mjs scripts/start-production.mjs
EXPOSE 10000
CMD ["node", "scripts/start-production.mjs"]
