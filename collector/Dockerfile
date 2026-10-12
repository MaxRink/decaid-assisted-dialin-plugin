FROM node:24-alpine
WORKDIR /app
COPY research-sharing.js ./research-sharing.js
COPY collector/server.js collector/metrics.js ./collector/
RUN mkdir -p /var/lib/research && chown node:node /var/lib/research
USER node
ENV RESEARCH_DATA_DIR=/var/lib/research RESEARCH_BIND_HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["node", "collector/server.js"]
