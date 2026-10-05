# Build the context with: node network/build.mjs <output-directory>
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY enclave-tuna agent.mjs /opt/enclave-tuna/
ENTRYPOINT ["node", "/opt/enclave-tuna/agent.mjs", "--config", "/etc/enclave-tuna/config.json"]
