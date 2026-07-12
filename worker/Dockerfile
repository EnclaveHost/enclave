# Enclave GPU worker (CuPy). cupy-cuda12x ships precompiled wheels, so this needs NO
# compiler, NO dev headers, and NO NumPy<2 pinning — runtime base is enough.
# Config gives it runtime:nvidia, gpus:all, ipc:host, and the shared
# /tmp/nvidia-mps mount so it joins the MPS daemon.
FROM nvidia/cuda:12.6.2-runtime-ubuntu24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip curl \
    && rm -rf /var/lib/apt/lists/*

# nvidia-ml-py: NVML bindings for the CC attestation report (/attestation);
# report generation is pure NVML, so the manager still never holds a CUDA context.
RUN pip3 install --break-system-packages --no-cache-dir cupy-cuda12x nvidia-ml-py

COPY worker.py /worker.py
ENV WORKER_PORT=8090
# Control-plane hardening. The manager binds loopback by default (the supervisor
# reaches it on localhost); override WORKER_BIND only if the manager must listen
# off-host. WORKER_TOKEN is the shared bearer secret required on every endpoint —
# leave it unset and the manager runs UNAUTHENTICATED with a loud boot warning
# (so nothing breaks before the supervisor is wired to send it); set it (in the
# runtime env, never baked into the image) to close the control plane and the
# trusted-PTX path. Do NOT reuse the fleet SECRET here — the supervisor doesn't
# forward a token to the worker yet, so keying off SECRET would lock it out.
ENV WORKER_BIND=127.0.0.1
# EXPOSE is metadata only; with the default loopback bind nothing is published.
EXPOSE 8090
CMD ["python3", "/worker.py"]
