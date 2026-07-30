# forum-api — deployable to Railway / Fly / Render / any Docker host.
FROM node:22-slim

WORKDIR /app

# sharp ships prebuilt binaries for this base image
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

# Health check hits the DB too, so orchestrators catch database outages
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "start"]
