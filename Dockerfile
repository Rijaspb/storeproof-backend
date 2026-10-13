FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .
USER node

# Railway injects PORT; server.js already reads it
EXPOSE 3000

# Run node directly (not npm) so SIGTERM reaches the graceful shutdown handler
CMD ["node", "--import", "./instrument.js", "server.js"]
