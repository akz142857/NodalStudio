FROM rust:1.95-bookworm AS builder
WORKDIR /app
COPY . .
RUN cargo build --release -p nodalstudio-cloud-api

FROM debian:bookworm-slim
RUN useradd --create-home --uid 10001 nodalstudio
COPY --from=builder /app/target/release/nodalstudio-cloud-api /usr/local/bin/cloud-api
USER nodalstudio
EXPOSE 8080
CMD ["cloud-api"]
