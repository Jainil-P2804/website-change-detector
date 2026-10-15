# Playwright image ships Chromium and all required system libraries.
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app

COPY package.json ./
COPY prisma ./prisma
RUN npm install --omit=dev && npx prisma generate

COPY src ./src
COPY web ./web

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/api/server.js"]
