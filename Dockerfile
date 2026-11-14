FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json prisma.config.ts ./
COPY packages/sign-in/package.json packages/sign-in/package.json
COPY packages/sign-in/src/adapters/prisma/schema.prisma packages/sign-in/src/adapters/prisma/schema.prisma
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:26-bookworm-slim
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/sign-in/package.json ./packages/sign-in/package.json
COPY --from=build /app/packages/sign-in/dist ./packages/sign-in/dist
USER node
EXPOSE 3000
ENTRYPOINT ["node", "packages/sign-in/dist/bin/aeolus-sign-in.js"]
CMD ["serve"]
