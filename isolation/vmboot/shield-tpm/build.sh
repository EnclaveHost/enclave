#!/bin/sh
# Build the paravisor TPM driver (isolation/m3/vtpm/enclave_openhcl_tpm.c) as a module for a distribution kernel.
#
#   sh isolation/vmboot/shield-tpm/build.sh HEADERS_DIR RELEASE OUT_DIR
#
# HEADERS_DIR holds the kernel's header packages as they sit under /usr/src (linux-headers-<version> and
# linux-headers-<release>, with Module.symvers), for example extracted from the image that carries the kernel:
#   debugfs -R "rdump /usr/src/linux-headers-6.8.0-147 HEADERS_DIR" root.img          (and the -generic one)
# The build runs in an ubuntu:24.04 container with gcc-13, the compiler Ubuntu built that kernel with; the packages
# it installs come from Ubuntu's archive at build time. Out: OUT_DIR/enclave_openhcl_tpm.ko and its sha256.
set -eu
headers=$(realpath "$1"); release=$2; out=$(realpath "$3")
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
cp "$here/../../m3/vtpm/enclave_openhcl_tpm.c" "$here/tpm.h" "$work/"
printf 'obj-m := enclave_openhcl_tpm.o\nccflags-y += -I$(src)\n' > "$work/Makefile"
docker run --rm -v "$headers":/usr/src:ro -v "$work":/src:ro -v "$out":/out ubuntu:24.04 sh -c "
  set -e; export DEBIAN_FRONTEND=noninteractive
  apt-get -qq update >/dev/null; apt-get -qq install -y gcc-13 make libelf1t64 kmod >/dev/null 2>&1
  cp -r /src /build
  make -s -C /usr/src/linux-headers-$release M=/build modules >/dev/null
  strip --strip-debug /build/enclave_openhcl_tpm.ko
  modinfo -F vermagic /build/enclave_openhcl_tpm.ko | grep -q '^$release ' || { echo 'vermagic is not $release' >&2; exit 1; }
  install -m 0444 /build/enclave_openhcl_tpm.ko /out/enclave_openhcl_tpm.ko"
sha256sum "$out/enclave_openhcl_tpm.ko"
