# MPS control daemon sidecar. The CUDA runtime image already ships
# nvidia-cuda-mps-control. Needs runtime:nvidia + gpus:all + ipc:host in the
# Tinfoil config so it can own the GPU's MPS server.
# Base pinned by DIGEST, not just the mutable tag: this image is part of the
# MEASURED enclave TCB, and its sidecar digest is what enclaves/*/tinfoil-config.yml
# commits to. An upstream repush of the same tag silently changes the measurement,
# which is exactly what the reproducibility claim behind METAL_ALLOWED_MEASUREMENTS
# cannot survive (see the root Dockerfile, which has always pinned). This digest is
# what the tag resolved to when it was pinned, so pinning changed nothing about what
# gets built - it only stopped it drifting. Re-pin deliberately on a base bump.
FROM nvidia/cuda:12.6.2-base-ubuntu24.04@sha256:631ec7090c36ab846cf021073ff4a64fb9cffa90b4f9f0083799288c607073ce
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
