FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=80 \
    DATA_DIR=/data \
    NODE_NO_WARNINGS=1

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node

# Exposed only to the Docker network – no host port binding.
EXPOSE 80
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:80/healthz || exit 1

CMD ["node", "server/index.js"]
