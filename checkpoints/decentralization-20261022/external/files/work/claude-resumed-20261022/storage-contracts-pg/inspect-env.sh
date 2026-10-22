#!/bin/bash
# read-only metadata inventory: Go toolchain linkage and the pinned image's config (no container is created or run)
set -u
G=/usr/lib/go
echo "== go $(GOTOOLCHAIN=local $G/bin/go version)"
for b in $G/bin/go $G/bin/gofmt $G/pkg/tool/linux_amd64/{compile,link,asm,vet,cgo,buildid,cover,test2json}; do
  [ -e "$b" ] || { echo "missing $b"; continue; }
  i=$(file -b "$b" | cut -c1-120); g=$(readelf -V "$b" 2>/dev/null | grep -o 'GLIBC_[0-9.]*' | sort -Vu | tail -1)
  echo "$(basename "$b"): $i ${g:+maxGLIBC=$g}"
done
echo "== host glibc: $(ldd --version | head -1)"
echo "== image"; docker image inspect postgres:18.6 --format 'Id={{.Id}} RepoDigests={{.RepoDigests}} User={{.Config.User}} Entrypoint={{.Config.Entrypoint}} Cmd={{.Config.Cmd}} Volumes={{.Config.Volumes}} StopSignal={{.Config.StopSignal}}'
docker image inspect postgres:18.6 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -v -i pass
echo "== docker"; docker version --format 'server={{.Server.Version}} api={{.Server.APIVersion}} client={{.Client.Version}}'; docker info --format 'rootless={{.SecurityOptions}} cgroup={{.CgroupDriver}} v={{.CgroupVersion}} swapLimit={{.SwapLimit}} memLimit={{.MemoryLimit}}'
echo "== modcache $(go env GOMODCACHE) owner $(stat -c '%U %a' $(go env GOMODCACHE))"; id
