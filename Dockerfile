FROM node:22-bookworm

WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --force

COPY . .
RUN npm run build
RUN npx playwright install --with-deps chromium

CMD ["sh", "-c", "node scripts/seed-db.mjs && node dist/index.js"]
