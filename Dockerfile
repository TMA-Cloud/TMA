# syntax=docker/dockerfile:1.7
# TMA Cloud: one image with the server (API, worker, admin commands) and the
# web app it serves.
#
#   docker build --build-arg VERSION=<tag> -t tma-cloud .
#   docker run -p 3000:3000 --env-file .env tma-cloud            # API + web app
#   docker run --env-file .env tma-cloud tma-server worker       # background worker

ARG RUST_VERSION=1
ARG TRUNK_VERSION=0.21.14

# The web app: the egui interface compiled to WebAssembly by trunk.
FROM rust:${RUST_VERSION}-bookworm AS web
ARG TRUNK_VERSION
RUN rustup target add wasm32-unknown-unknown \
    && curl -fsSL "https://github.com/trunk-rs/trunk/releases/download/v${TRUNK_VERSION}/trunk-x86_64-unknown-linux-gnu.tar.gz" | tar -xz -C /usr/local/bin \
    && apt-get update && apt-get install -y --no-install-recommends brotli && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=tma-web-target,target=/src/target \
    cd apps/tma-cloud-web \
    && trunk build --release --cargo-profile wasm-release \
    && find dist -type f \( -name '*.wasm' -o -name '*.js' -o -name '*.html' -o -name '*.webmanifest' \) \
       -exec gzip -9 -k {} \; -exec brotli -q 11 -k {} \; \
    && cp -r dist /web

# The server.
FROM rust:${RUST_VERSION}-bookworm AS server
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=tma-server-target,target=/src/target \
    cargo build --release --locked -p tma-server \
    && cp target/release/tma-server /tma-server

# Runtime: glibc and nothing else; the server needs no shell, curl or OpenSSL.
FROM gcr.io/distroless/cc-debian12
ARG VERSION=unknown
LABEL org.opencontainers.image.title="TMA Cloud" \
      org.opencontainers.image.description="Self-hosted cloud storage" \
      org.opencontainers.image.source="https://github.com/TMA-Cloud/TMA" \
      org.opencontainers.image.version="${VERSION}"
COPY --from=server /tma-server /usr/local/bin/tma-server
COPY --from=web /web /app/web
ENV APP_ENV=production \
    WEB_DIST_DIR=/app/web \
    PORT=3000
# Matches the uid that setup.sh gives the encryption key file to.
USER 1001:1001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["tma-server", "healthcheck"]
ENTRYPOINT []
CMD ["tma-server", "serve"]
