FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY server ./server
COPY public ./public

# SQLite lives on a mounted volume so the database survives redeploys.
ENV DB_PATH=/data/wordworld.db
VOLUME /data

ENV PORT=3000
EXPOSE 3000
CMD ["node", "server/index.js"]
