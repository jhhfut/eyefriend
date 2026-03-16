# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

ARG GEMINI_API_KEY
ARG VITE_BACKEND_URL
ENV GEMINI_API_KEY=$GEMINI_API_KEY
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL

RUN npm run build

# ── Serve stage ───────────────────────────────────────────────────────────────
FROM node:20-slim AS runner

WORKDIR /app

RUN npm install -g serve

COPY --from=builder /app/dist ./dist

ENV PORT=8080
EXPOSE 8080

CMD ["serve", "-s", "dist", "-l", "8080"]
