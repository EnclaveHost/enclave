#!/bin/bash
# TEST-ONLY W2 probe: vet + build for windows/amd64, offline (x/sys v0.48.0 from the module cache).
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/hosted-services-activation/winval/jobprobe
export GOPROXY=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=mod CGO_ENABLED=0 GOOS=windows GOARCH=amd64
go vet -unsafeptr=false ./...   # touch() writes VirtualAlloc memory (not the Go heap)
go build -trimpath -ldflags="-s -w -buildid=" -o ../dist/jobprobe.exe .
sha256sum ../dist/jobprobe.exe
