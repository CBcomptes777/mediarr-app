# --- 1. Compilation de l'app web ---
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web ./
RUN npm run build

# --- 2. Compilation du serveur ---
FROM node:22-alpine AS server
WORKDIR /server
COPY server/package*.json ./
RUN npm ci
COPY server ./
RUN npm run build && npm prune --omit=dev

# --- 3. Image finale ---
FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 PUBLIC_DIR=/app/public
WORKDIR /app
COPY --from=server /server/node_modules ./node_modules
COPY --from=server /server/dist ./dist
COPY --from=server /server/package.json ./package.json
COPY --from=web /web/dist ./public
# Dossier de repli des préférences quand aucun volume n'est monté sur /data (perdu si le conteneur est recréé).
# On ne crée volontairement PAS /data : son absence indique à l'app qu'aucun volume n'est monté.
RUN mkdir -p /app/data && chown node:node /app/data
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
