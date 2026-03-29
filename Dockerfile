# ---------- deps ----------
FROM node:20-alpine AS deps
WORKDIR /app

COPY package*.json ./
RUN npm ci

# ---------- build ----------
FROM node:20-alpine AS build
WORKDIR /app

# Needed for npm scripts
COPY package*.json ./

# Dependencies for TypeScript build
COPY --from=deps /app/node_modules ./node_modules

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ---------- runtime ----------
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Install only prod deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled output
COPY --from=build /app/dist ./dist

EXPOSE 3000

CMD ["npm", "run", "start"]
