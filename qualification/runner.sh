#!/usr/bin/env bash
set -euo pipefail
umask 077
# Invoked only by the branch-restricted workflow. No xtrace: the identity is secret.
repo_root=$PWD
scratch="$RUNNER_TEMP/reaper-scratch"
scratch_file="$RUNNER_TEMP/reaper-scratch.ext4"
out="$scratch/result"
mkdir -p "$scratch"
cleanup() {
  docker rm -f reaper-deps reaper-test reaper-build reaper-verify >/dev/null 2>&1 || true
  unset AGE_IDENTITY
}
trap cleanup EXIT
[[ $GITHUB_REPOSITORY == EnclaveHost/enclave ]]
[[ $GITHUB_REF == refs/heads/build/lease-reaper-artifact-20261028 ]]
[[ $EXPECTED_SHA =~ ^[0-9a-f]{40}$ && $GITHUB_SHA == "$EXPECTED_SHA" ]]
[[ $(git rev-parse HEAD) == "$EXPECTED_SHA" ]]
[[ $INPUT_TAG =~ ^reaper-input-20261028-[0-9a-f]{12}$ && $INPUT_SHA256 =~ ^[0-9a-f]{64}$ ]]
[[ $ENVIRONMENT_NAME =~ ^reaper-artifact-20261028-[0-9a-f]{12}$ ]]
[[ $AGE_RECIPIENT =~ ^age1[0-9a-z]{58}$ ]]
[[ $TRANSPORT_EXPIRES =~ ^[0-9]{10}$ ]]
now=$(date +%s)
(( TRANSPORT_EXPIRES > now && TRANSPORT_EXPIRES <= now + 86400 ))
fallocate -l 2G "$scratch_file"
mkfs.ext4 -q -F -m 0 "$scratch_file"
sudo mount -o loop,nodev,nosuid "$scratch_file" "$scratch"
sudo chown "$(id -u):$(id -g)" "$scratch"
mkdir "$scratch/base" "$scratch/deps" "$scratch/tmp" "$out"
curl --fail --silent --show-error --location --max-time 120 \
  https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-linux-amd64.tar.gz \
  -o "$scratch/age.tar.gz"
printf '%s  %s\n' cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10 "$scratch/age.tar.gz" | sha256sum -c -
tar -xzf "$scratch/age.tar.gz" -C "$scratch" age/age age/age-keygen
[[ $("$scratch/age/age-keygen" -y /dev/fd/3 3<<<"$AGE_IDENTITY") == "$AGE_RECIPIENT" ]]
curl --fail --silent --show-error --location --max-time 180 \
  "https://github.com/EnclaveHost/enclave/releases/download/$INPUT_TAG/input.tar.age" -o "$scratch/input.age"
printf '%s  %s\n' "$INPUT_SHA256" "$scratch/input.age" | sha256sum -c -
"$scratch/age/age" -d -i /dev/fd/3 -o "$scratch/input.tar" "$scratch/input.age" 3<<<"$AGE_IDENTITY"
unset AGE_IDENTITY
rm "$scratch/input.age"
python3 qualification/unpack-input.py "$scratch/input.tar" "$scratch/base"
rm "$scratch/input.tar"
python3 qualification/verify-image.py "$scratch/base"
cp package.json package-lock.json "$scratch/deps/"
node_image=node:22-bookworm@sha256:94c973596a8581a87ba42746ceb0b0e0b5246d098de45b1ce04dcc967cfc5dfb
python_image=python:3.12-bookworm@sha256:034c3e9d991f148d14c32ff8350286b91420baca7757d37819c7a9cc771317a0
docker pull "$node_image"
docker pull "$python_image"
limits=(--user="$(id -u):$(id -g)" -e HOME=/tmp --cpus=1 --memory=512m --memory-swap=512m --pids-limit=128 --read-only --cap-drop=ALL --security-opt=no-new-privileges --tmpfs /tmp:rw,nosuid,nodev,size=32m)
docker run --rm --name reaper-deps "${limits[@]}" \
  -e REAPER_EXPECTED_UID="$(id -u)" -v "$scratch/deps:/deps" -w /deps "$node_image" \
  node --input-type=module -e '
    import fs from "node:fs";
    import assert from "node:assert/strict";
    import {spawnSync} from "node:child_process";
    assert.equal(process.getuid(),Number(process.env.REAPER_EXPECTED_UID),"container UID mismatch");
    const files=["package.json","package-lock.json"].map(name=>{
      fs.accessSync(name,fs.constants.R_OK);
      const stat=fs.statSync(name), data=JSON.parse(fs.readFileSync(name,"utf8"));
      assert.equal(stat.uid,process.getuid(),"input owner mismatch");
      if(name==="package-lock.json") assert.ok(data.lockfileVersion>=1,"missing lockfile version");
      return {name,uid:stat.uid,mode:(stat.mode&511).toString(8),lockfileVersion:data.lockfileVersion};
    });
    fs.writeFileSync(".permission-probe","public permission probe",{flag:"wx",mode:384});
    fs.unlinkSync(".permission-probe");
    console.log(JSON.stringify({preflight:"passed",uid:process.getuid(),files,writeDeps:true}));
    const result=spawnSync("npm",["ci","--omit=dev","--ignore-scripts","--no-audit","--no-fund","--cache","/tmp/npm"],{stdio:"inherit"});
    if(result.error) throw result.error;
    process.exit(result.status ?? 1);
  ' > "$out/dependencies.log" 2>&1
mkdir -p "$repo_root/node_modules"
docker run --rm --name reaper-test "${limits[@]}" --network=none \
  -v "$repo_root:/src:ro" -v "$scratch/deps/node_modules:/src/node_modules:ro" -w /src "$node_image" \
  node --test --test-timeout=120000 test/lease-expiry-reconcile.test.mjs > "$out/tests.tap" 2>&1
docker run --rm --name reaper-build "${limits[@]}" --network=none \
  -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0=/src \
  -v "$repo_root:/src:ro" -v "$scratch:/scratch" -w /src "$python_image" \
  python3 metal/overlay-control-image.py /scratch/base /scratch/candidate "$EXPECTED_SHA" > "$out/build.log" 2>&1
docker run --rm --name reaper-verify "${limits[@]}" --network=none \
  -v "$repo_root:/src:ro" -v "$scratch:/scratch" -w /src "$python_image" \
  python3 qualification/verify-image.py /scratch/base /scratch/candidate "$EXPECTED_SHA" /scratch/result.json
cp "$scratch/result.json" "$out/result.json"
tar -cf "$scratch/candidate.tar" -C "$scratch/candidate" initramfs.cpio.gz vmlinuz cmdline manifest.json
sha256sum "$scratch/candidate.tar" | awk '{print $1}' > "$out/plaintext-archive.sha256"
"$scratch/age/age" -r "$AGE_RECIPIENT" -o "$out/candidate.tar.age" "$scratch/candidate.tar"
sha256sum "$out/candidate.tar.age" | awk '{print $1}' > "$out/ciphertext-archive.sha256"
# Only ciphertext and nonsecret diagnostics leave this ephemeral runner.
