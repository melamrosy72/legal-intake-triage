# Node 24 LTS: the Nest CLI's tooling needs Node ^22.22.3 or >=24.15.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Scripts skipped here: postinstall runs `prisma generate`, which needs the sources copied below.
RUN npm ci --ignore-scripts
COPY . .
RUN npx prisma generate && npm run build

# Runtime: production dependencies and the compiled app only. The Prisma client is generated
# TypeScript compiled into dist/, so no Prisma CLI is needed here.
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# ponytail: the image still carries the Prisma CLI and typescript (~100 MB): npm installs them as
# required peers of @prisma/client even with --omit=dev/--omit=peer. Prune them if size matters.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
