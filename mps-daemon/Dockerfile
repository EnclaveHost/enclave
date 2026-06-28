# MPS control daemon sidecar. The CUDA runtime image already ships
# nvidia-cuda-mps-control. Needs runtime:nvidia + gpus:all + ipc:host in the
# Tinfoil config so it can own the GPU's MPS server.
FROM nvidia/cuda:12.6.2-base-ubuntu24.04
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
