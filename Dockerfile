# Headless runner image: Node + Playwright Chromium + k6.
# Build:  docker build -t dxp-loadtest .
# Run:    docker run --rm -it --env-file .env -v "$PWD/envs:/app/envs" -v "$PWD/config:/app/config" \
#           -v "$PWD/catalogs:/app/catalogs" -v "$PWD/runs:/app/runs" -v "$PWD/.auth:/app/.auth" \
#           -v "$HOME/Documents/work/api_gateway:/gateway:ro" -e LT_GATEWAY_CONFIG_DIR=/gateway \
#           dxp-loadtest run --env <name>
FROM mcr.microsoft.com/playwright:v1.64.1-noble

ARG K6_VERSION=2.3.0
ARG TARGETARCH
RUN curl -fsSL "https://github.com/grafana/k6/releases/download/v${K6_VERSION}/k6-v${K6_VERSION}-linux-${TARGETARCH:-amd64}.tar.gz" \
    | tar -xz -C /tmp \
  && mv "/tmp/k6-v${K6_VERSION}-linux-${TARGETARCH:-amd64}/k6" /usr/local/bin/k6 \
  && k6 version

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY config ./config
COPY envs ./envs
COPY mock ./mock

ENTRYPOINT ["npx", "tsx", "src/cli.ts"]
CMD ["--help"]
