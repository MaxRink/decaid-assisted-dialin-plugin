# Base pinned by digest (Dependabot docker updates it). This is the exact base
# of the deployed collector image built from 070028d (layer diff_ids match).
FROM node:26.12.0-alpine3.24@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5
WORKDIR /app
COPY research-sharing.js ./research-sharing.js
COPY collector/server.js collector/metrics.js ./collector/
COPY collector/telemetry.js ./collector/
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && mkdir -p /var/lib/research && chown node:node /var/lib/research
USER node
ENV RESEARCH_DATA_DIR=/var/lib/research RESEARCH_BIND_HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["node", "collector/server.js"]
