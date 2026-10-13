# Host-side cache for public, pinned content (Shield apps)

Status: design + first implementation (2026-10-12). Not deployed.

## Problem

A Shield app on a Windows host reaches the internet only through its own TUNA circuits, paid per byte in native NKN.
An app that pulls large **public** objects pays for them again on every start, and again whenever a circuit drops
mid-download. risc-box pulls a ~1 GB disk image: on nucbox-k11-4 on 2026-10-12 two apps burned ~1.2 NKN/hour, and
the image restarted from byte zero after drops (risc-box 0.6.68 fixes the restart; the cost of every cold start remains).

The bytes are public and the app already knows exactly which bytes it wants (it can pin their sha256). Routing them
through a privacy circuit buys nothing: the host learns nothing it could not already read in the app's public config.

## Design

```
guest app --SOCKS (the front, public-web egress)--> host shield-egress --"blobs.enclave.internal:80"--> node blob service
                                                                       (any other name: the app's TUNA route, unchanged)
node blob service --HTTPS, direct, once--> the object's public source URL ; cache: ProgramData\Enclave\shield\blobs
```

1. **Reserved name.** `blobs.enclave.internal`, port 80, plain HTTP. `shield-egress` dials it to the node's blob
   service on loopback instead of through the app's route (flag `-blob-service 127.0.0.1:PORT`; unset = off, the name
   then fails like any unresolvable one). Per-domain connection caps still apply. No other name changes behaviour.
2. **Request.** `GET /sha256/<64 hex>?src=<url-encoded https URL>`; `Range: bytes=N-` is honoured once cached.
3. **Host service** (`windows/node/blob-cache.mjs`):
   - a cached object (file named by its sha256) is served from disk at local speed, with Range;
   - otherwise the source is fetched **once** (concurrent requests for one hash share the download), streamed to the
     requester while it is hashed to a temp file, and committed to the cache only if the sha256 matches;
   - the source must be `https:`, have no userinfo and **no query string** (a presigned URL carries credentials: the
     host must never be handed one), and resolve only to public addresses; objects over 4 GiB are refused;
   - the cache is capped (default 32 GiB), least recently used first out.
4. **Integrity.** The guest verifies the sha256 of what it receives, always: the host can delay or refuse a blob but
   cannot substitute one. The host verifies too, so it never keeps or re-serves a bad object.
5. **App side.** An app that wants it lists `{sha256, src}` for its public objects and asks the blob service first,
   falling back to its normal path (risc-box: S3 through its route) on any failure or hash mismatch.

## Privacy

What the host learns: which public object (hash + public URL) a deployment fetched. Both are in the app's public
config already. Nothing private crosses: credentials stay in the guest (presigned URLs are refused), and every other
flow keeps its TUNA route. Apps must only list content that is genuinely public.

## Not in scope (yet)

Pre-fetching objects on claim; sharing a cache between hosts; private objects; Linux hosts.
