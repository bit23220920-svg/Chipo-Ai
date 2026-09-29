# Dockerfile
#
# Node 22, matching what this project has been developed and tested against
# (server.js requires Node's built-in fetch/structuredClone-era runtime).
# None of this project's dependencies (mysql2, bcryptjs, jsonwebtoken, pdf-parse)
# need native compilation, so a plain slim image is enough — no build-essential,
# no python, no node-gyp.

FROM node:22-slim

WORKDIR /app

# Install dependencies first so this layer is cached unless package*.json changes
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Now copy the rest of the app
COPY . .

# Never bake real secrets into the image — .env is excluded via .dockerignore.
# Real config is supplied at run time via docker-compose's environment/env_file.

ENV NODE_ENV=production
EXPOSE 3000

# Run the (idempotent) schema migration, then start the server. If the
# database isn't reachable yet, migrate.js exits non-zero and the container
# restarts (see docker-compose.yml's restart policy) until MariaDB is up.
CMD ["sh", "-c", "node migrate.js && node server.js"]
# Missing Dockerfile structure to match your .dockerignore
FROM node:18-alpine
WORKDIR /app
COPY C:\Users\Nalu Misebezi\Downloads\uni-chatbot-updated\package-lock.json
RUN npm install
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]