FROM node:24-alpine AS builder
WORKDIR /app
ARG VITE_CLOUD_API_URL=/api
ENV VITE_CLOUD_API_URL=$VITE_CLOUD_API_URL
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/frontend/package.json apps/frontend/package.json
RUN pnpm install --frozen-lockfile
COPY apps/frontend apps/frontend
RUN pnpm --filter @nodalstudio/frontend build

FROM nginx:1.29-alpine
COPY apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/frontend/dist /usr/share/nginx/html
EXPOSE 80
