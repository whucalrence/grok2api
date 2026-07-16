FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY patcher.js session.js server.js healthcheck.js ./

ENV NODE_ENV=production \
    PORT=3000 \
    GROK_BASE_URL=https://grok.com

USER pwuser

EXPOSE 3000

CMD ["node", "server.js"]
