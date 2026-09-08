#!/usr/bin/env python3
"""The dealer's loop (shielded/dealer/PLAN.md P3): keep one pVM's bank of pad
shipments ahead of its ledger mark, mint missing delivery ranges, prune only acknowledged files.

  dealer-loop.py --relay https://api.enclave.host --name pixel-1 --master <hex64> \
                 --model model.gguf --calib model.calib --out /bank [--ahead 256] [--chunk 64] [--once]
  dealer-loop.py --seed <hex64> --seed-id <hex32> --pk <hex64> --mark N ...      (offline: no relay)
  dealer-loop.py --derive-only --master <hex64> --keyfp <hex64> [--epoch 1]     (prints seed + seed_id)
  dealer-loop.py --plan-only --out DIR --seed-id ID --mark N [--ahead --chunk]   (prints the ranges it would mint)

Environment for the minting tool: DEALER (path to shielded-dealer), SHIELDED_SO,
GGML_CPU_SO, LD_LIBRARY_PATH. The seed is derived exactly as relay/pads.mjs does
(HKDF-SHA512, salt = keyFp bytes, info "enclave-pads-seed:<epoch>"); the master
seed is the platform's secret and never leaves the dealer's process.
"""
import argparse, fcntl, hashlib, hmac, json, os, re, subprocess, sys, tempfile, time, urllib.error, urllib.request


def hkdf_sha512(ikm: bytes, salt: bytes, info: bytes, length: int) -> bytes:
    prk = hmac.new(salt, ikm, hashlib.sha512).digest()
    out, t, ctr = b"", b"", 1
    while len(out) < length:
        t = hmac.new(prk, t + info + bytes([ctr]), hashlib.sha512).digest()
        out += t; ctr += 1
    return out[:length]


def derive_seed(master_hex: str, keyfp_hex: str, epoch: int = 1):
    master, keyfp = bytes.fromhex(master_hex), bytes.fromhex(keyfp_hex)
    seed = hkdf_sha512(master, keyfp, f"enclave-pads-seed:{epoch}".encode(), 32)
    seed_id = hkdf_sha512(master, keyfp, f"enclave-pads-seed-id:{epoch}".encode(), 16).hex()
    return seed.hex(), seed_id


PAD_INDEX_LIMIT = 1 << 24
NAME_RE = re.compile(r"^([0-9a-f]{32})-(0|[1-9][0-9]*)-([1-9][0-9]*)\.pads$")

def valid_range(index0, count):
    return type(index0) is int and type(count) is int and 0 <= index0 < PAD_INDEX_LIMIT and 0 < count <= PAD_INDEX_LIMIT - index0



def shipments(out_dir: str, seed_id: str):
    """(index0, count, path) of every shipment of this seed in the bank."""
    found = []
    for n in os.listdir(out_dir) if os.path.isdir(out_dir) else []:
        m = NAME_RE.match(n)
        if m and m.group(1) == seed_id and valid_range(int(m.group(2)), int(m.group(3))):
            found.append((int(m.group(2)), int(m.group(3)), os.path.join(out_dir, n)))
    return sorted(found)


def plan(existing, mark: int, ahead: int, chunk: int, ack_floor: int = 0, acked=(), max_pending: int = 1024):
    """Cover missing delivery from ack_floor through mark+ahead, not from mark.
    Emit exact gaps split at chunk boundaries, never re-mint acknowledged indices.
    The pending cap bounds retention when old consumers cannot acknowledge."""
    if any(type(x) is not int for x in (mark, ahead, chunk, ack_floor, max_pending)) or not (0 <= mark <= PAD_INDEX_LIMIT and 0 <= ack_floor <= PAD_INDEX_LIMIT and 0 < ahead <= PAD_INDEX_LIMIT and 0 < chunk <= PAD_INDEX_LIMIT and 0 < max_pending <= PAD_INDEX_LIMIT):
        raise ValueError("invalid pad planning bounds")
    previous = ack_floor
    if not isinstance(acked, (tuple, list)) or len(acked) > 64:
        raise ValueError("invalid acknowledgment ranges")
    for pair in acked:
        if not isinstance(pair, (tuple, list)) or len(pair) != 2 or not valid_range(pair[0], pair[1] - pair[0]) or pair[0] <= previous:
            raise ValueError("invalid acknowledgment range")
        previous = pair[1]
    covered = sorted([(i0, i0 + c) for i0, c, _ in existing if valid_range(i0, c)] + list(map(tuple, acked)))
    horizon = min(PAD_INDEX_LIMIT, ((mark + ahead + chunk - 1) // chunk) * chunk, ack_floor + max_pending)
    want, cursor = [], ack_floor
    def gap(end):
        nonlocal cursor
        while cursor < end:
            stop = min(end, ((cursor // chunk) + 1) * chunk)
            want.append((cursor, stop - cursor)); cursor = stop
    for lo, hi in covered:
        if hi <= cursor: continue
        if lo >= horizon: break
        if cursor < lo: gap(min(lo, horizon))
        cursor = max(cursor, hi)
    if cursor < horizon: gap(horizon)
    delivered = [p for i0, c, p in existing if valid_range(i0, c) and i0 + c <= ack_floor]
    return want, delivered


def relay_get(base: str, path: str):
    with urllib.request.urlopen(base.rstrip("/") + path, timeout=30) as r:
        return json.loads(r.read().decode())


def relay_put_file(base: str, seed_id: str, path: str, token: str):
    """Stream one shipment into the platform's store; the relay renames it only if the sha256 matches."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""): h.update(chunk)
    url = f"{base.rstrip('/')}/v1/pads/shipments/{seed_id}/{os.path.basename(path)}?sha256={h.hexdigest()}"
    with open(path, "rb") as f:
        req = urllib.request.Request(url, data=f, method="PUT", headers={"Authorization": "Bearer " + token, "Content-Length": str(os.path.getsize(path)), "Content-Type": "application/octet-stream"})
        with urllib.request.urlopen(req, timeout=3600) as r:
            return json.loads(r.read().decode())


def relay_delete(base: str, seed_id: str, name: str, token: str):
    req = urllib.request.Request(f"{base.rstrip('/')}/v1/pads/shipments/{seed_id}/{name}", method="DELETE", headers={"Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=60) as r: return r.status
    except urllib.error.HTTPError as e: return e.code


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--relay"); ap.add_argument("--name")
    ap.add_argument("--all", action="store_true", help="serve every consumer the relay lists (GET /v1/pads/consumers) instead of one --name")
    ap.add_argument("--master"); ap.add_argument("--keyfp"); ap.add_argument("--epoch", type=int, default=1)
    ap.add_argument("--seed"); ap.add_argument("--seed-id"); ap.add_argument("--pk"); ap.add_argument("--mark", type=int)
    ap.add_argument("--ack-floor", type=int, default=None, help="offline delivered floor; NEVER inferred from --mark")
    ap.add_argument("--max-pending", type=int, default=1024, help="maximum unacknowledged index span retained before waiting for delivery progress")
    ap.add_argument("--model"); ap.add_argument("--calib"); ap.add_argument("--out")
    ap.add_argument("--ahead", type=int, default=256); ap.add_argument("--chunk", type=int, default=64)
    ap.add_argument("--mint-batch", type=int, default=0, help="shipments per dealer run (0 = all missing at once); small values push the first shipments sooner at the cost of extra model loads")
    ap.add_argument("--once", action="store_true"); ap.add_argument("--interval", type=float, default=30.0)
    ap.add_argument("--worker", default=os.environ.get("DEALER_WORKER", ""), help="host:port of the dealer's OWN worker (GPU minting; never an operator's)")
    ap.add_argument("--derive-only", action="store_true"); ap.add_argument("--plan-only", action="store_true")
    ap.add_argument("--push", action="store_true", help="upload each new shipment to the relay's store and delete acknowledged ones there (needs PADS_DEALER_TOKEN)")
    a = ap.parse_args()

    if a.derive_only:
        seed, seed_id = derive_seed(a.master, a.keyfp, a.epoch)
        print(json.dumps({"seed": seed, "seed_id": seed_id})); return 0

    if not a.out: sys.exit("need --out")
    # One writer owns a bank, including across concurrent daemon invocations.
    # A read-only plan does not take the writer lock.
    if not a.plan_only:
        os.makedirs(a.out, exist_ok=True)
        bank_lock = open(os.path.join(a.out, ".dealer-loop.lock"), "a")
        try: fcntl.flock(bank_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: sys.exit("another dealer already owns this bank")

    token = os.environ.get("PADS_DEALER_TOKEN", "")
    if a.push and not (a.relay and token): sys.exit("--push needs --relay and PADS_DEALER_TOKEN")

    warned_old, warned_cap = set(), set()
    def prune_and_plan(seed_id, mark, ack_floor=None, acked=(), finalized=False):
        """A failed store listing permits neither destructive cleanup nor speculative re-mint."""
        if finalized:
            print(f"seed {seed_id} finalized; no further mint", flush=True); return []
        if ack_floor is None:
            ack_floor = 0
            if seed_id not in warned_old and not a.plan_only:
                print(f"seed {seed_id}: no delivery floor; planning from 0, pruning nothing (retention capped at {a.max_pending} indices)", flush=True)
                warned_old.add(seed_id)
        existing = shipments(a.out, seed_id)
        stored = []
        if a.push:
            try:
                listing = relay_get(a.relay, f"/v1/pads/shipments?seed_id={seed_id}").get("shipments")
                if not isinstance(listing, list): raise ValueError("invalid shipment listing")
                for item in listing:
                    if not isinstance(item, dict): raise ValueError("invalid shipment entry")
                    name = item.get("name", ""); m = NAME_RE.fullmatch(name)
                    if not m or m.group(1) != seed_id or not valid_range(int(m.group(2)), int(m.group(3))): raise ValueError("invalid shipment name")
                    i0, count = int(m.group(2)), int(m.group(3))
                    if item.get("index0") != i0 or item.get("count") != count or type(item.get("bytes")) is not int or item["bytes"] <= 0: raise ValueError("invalid shipment metadata")
                    stored.append((i0, count, name))
            except (urllib.error.HTTPError, urllib.error.URLError, OSError, ValueError) as e:
                print(f"store listing failed ({getattr(e, 'code', None) or getattr(e, 'reason', e)}); no mint, prune or upload until it recovers", flush=True)
                return []
        want, _ = plan(existing + stored, mark, a.ahead, a.chunk, ack_floor, acked, a.max_pending)
        local_spent = [p for i0,c,p in existing if i0+c <= ack_floor]
        if a.plan_only:
            print(json.dumps({"seed_id": seed_id, "mark": mark, "ack_floor": ack_floor, "mint": want, "prune": local_spent})); return []
        if mark + a.ahead > ack_floor + a.max_pending and seed_id not in warned_cap:
            print(f"seed {seed_id}: pending delivery cap reached; will not extend beyond {ack_floor + a.max_pending} until acknowledgments advance", flush=True)
            warned_cap.add(seed_id)
        elif mark + a.ahead <= ack_floor + a.max_pending:
            warned_cap.discard(seed_id)
        for p in local_spent:
            os.unlink(p); print(f"pruned {os.path.basename(p)} (delivered floor {ack_floor})", flush=True)
        if a.push:
            have = {name for _,_,name in stored}
            for i0,c,name in stored:
                if i0+c <= ack_floor:
                    print(f"relay prune {name} -> {relay_delete(a.relay, seed_id, name, token)}", flush=True)
            for _,_,p in shipments(a.out, seed_id):
                name = os.path.basename(p)
                if name in have: continue
                try:
                    res = relay_put_file(a.relay, seed_id, p, token)
                    print(f"re-pushed {name}: {res.get('bytes')} bytes (store lacked it)", flush=True)
                except (urllib.error.HTTPError, urllib.error.URLError, OSError) as e:
                    print(f"push of {name} failed: {getattr(e, 'code', None) or getattr(e, 'reason', e)}; retained for retry", flush=True)
        if not want: print(f"no missing delivery ranges for {seed_id} (mark {mark}, delivered floor {ack_floor})", flush=True)
        return want

    def mint(jobs):
        """jobs: [(seed, seed_id, pk, want)] -> ONE dealer run (one model load), then push. Seeds
        go through a 0600 file that lives only for the run. With --mint-batch N the wanted ranges
        are minted and pushed N shipments at a time, so a consumer that is already decoding sees
        its first shipment after one small run instead of after the whole window."""
        jobs = [j for j in jobs if j[3]]
        if not jobs: return
        if a.mint_batch > 0 and any(len(j[3]) > a.mint_batch for j in jobs):
            pending = [list(j[3]) for j in jobs]
            while any(pending):
                part = [(j[0], j[1], j[2], pend[:a.mint_batch]) for j, pend in zip(jobs, pending)]
                for pend in pending: del pend[:a.mint_batch]
                mint_once(part)
            return
        mint_once(jobs)

    def mint_once(jobs):
        jobs = [j for j in jobs if j[3]]
        if not jobs: return
        if not (a.model and a.calib): sys.exit("minting needs --model and --calib")
        for seed, seed_id, pk, _ in jobs:
            if not (seed and pk): sys.exit(f"minting {seed_id} needs its seed (--seed or --master) and pad key (--pk or the consumer's)")
        dealer = os.environ.get("DEALER", "shielded-dealer")
        fd, jobfile = tempfile.mkstemp(prefix="dealer-jobs-", suffix=".txt", dir=a.out)
        try:
            with os.fdopen(fd, "w") as f:
                for seed, seed_id, pk, want in jobs:
                    ranges = ",".join(f"{i0}:{c}" for i0, c in want)
                    tmpl = os.path.join(a.out, f"{seed_id}-{{index0}}-{{count}}.pads")
                    f.write(f"{seed} {seed_id} {pk} {tmpl} {ranges}\n")
            cmd = [dealer, a.model, "--jobs", jobfile]
            if a.worker: cmd += ["--worker", a.worker]
            env = {**os.environ, "SHIELDED_CALIB": a.calib}
            t0 = time.time()
            # Streaming publish: shielded-dealer prints "minted <path>: indices [a, b), ..." and flushes
            # right after each shipment file is closed, so a consumer that is already decoding gets its
            # first shipment while the same process (one model load) keeps minting the rest. Only paths
            # from this run's plan are pushed, and only once the line for them has been seen.
            planned = {os.path.join(a.out, f"{seed_id}-{i0}-{c}.pads"): (seed_id, i0, c) for seed, seed_id, pk, want in jobs for i0, c in want}
            pushed_now = set()
            proc = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            for line in proc.stdout:
                if not (a.push and line.startswith("minted ")): continue
                path = line[len("minted "):].split(": indices", 1)[0].strip()
                if path not in planned or path in pushed_now: continue
                seed_id_p, i0, c = planned[path]
                try:
                    res = relay_put_file(a.relay, seed_id_p, path, token)
                    pushed_now.add(path)
                    print(f"  pushed {os.path.basename(path)} (streamed, {time.time() - t0:.1f} s): {res.get('bytes')} bytes, sha256 {str(res.get('sha256'))[:16]}", flush=True)
                except (urllib.error.HTTPError, urllib.error.URLError, OSError) as e:
                    print(f"  streamed push of {os.path.basename(path)} failed: {getattr(e, 'code', None) or getattr(e, 'reason', e)}; retried below", flush=True)
            rc = proc.wait()
            if rc != 0: sys.exit(f"shielded-dealer failed ({rc}) for {len(jobs)} job(s)")
        finally:
            try: os.unlink(jobfile)
            except OSError: pass
        for seed, seed_id, pk, want in jobs:
            print(f"minted {len(want)} shipment(s) for {seed_id} covering up to {want[-1][0] + want[-1][1]}" + (f" in {time.time() - t0:.1f} s (one load for {len(jobs)} consumer(s))" if seed_id == jobs[-1][1] else ""), flush=True)
            if a.push:
                for i0, c in want:
                    fpath = os.path.join(a.out, f"{seed_id}-{i0}-{c}.pads")
                    if fpath in pushed_now: continue   # already published while minting
                    try:
                        res = relay_put_file(a.relay, seed_id, fpath, token)
                        print(f"  pushed {os.path.basename(fpath)}: {res.get('bytes')} bytes, sha256 {str(res.get('sha256'))[:16]}", flush=True)
                    except (urllib.error.HTTPError, urllib.error.URLError, OSError) as e:
                        # a refused upload (wrong bearer, relay restarting) is retried by the
                        # store sync on the next pass; the bank keeps the file
                        print(f"  push of {os.path.basename(fpath)} failed: {getattr(e, 'code', None) or getattr(e, 'reason', e)} (is PADS_DEALER_TOKEN the relay's?); next pass retries", flush=True)

    def serve(seed, seed_id, pk, mark, ack_floor, acked=(), finalized=False):
        mint([(seed, seed_id, pk, prune_and_plan(seed_id, mark, ack_floor, acked, finalized))])

    while True:
        if a.all:
            # the dealer daemon: every attached consumer with a pad key, each
            # pass (one model load per consumer for now; a multi-seed mint in
            # one load is the obvious next step for the 27B)
            if not (a.relay and a.master): sys.exit("--all needs --relay and --master")
            try:
                cons = relay_get(a.relay, "/v1/pads/consumers").get("consumers", [])
            except (urllib.error.HTTPError, urllib.error.URLError, OSError) as e:
                print(f"relay {a.relay} unreachable ({getattr(e, 'code', None) or getattr(e, 'reason', e)}); waiting", flush=True)
                if a.once: return 1
                time.sleep(a.interval); continue
            served, jobs = 0, []
            for c in cons:
                if not c.get("issued"):
                    continue                     # attached, but never asked for its seed: nothing to mint for yet
                seed, sid = derive_seed(a.master, c["keyFp"], c.get("epoch", a.epoch))
                if sid != c["seed_id"]:
                    print(f"consumer {c['name']}: seed id mismatch (relay {c['seed_id']}, derived {sid}); skipped", flush=True); continue
                print(f"consumer {c['name']} ({sid}, mark {c.get('mark', 0)})", flush=True)
                jobs.append((seed, sid, c.get("padKey") or "", prune_and_plan(sid, c.get("mark", 0), c.get("ack_floor"), c.get("acked", []), c.get("finalized", False)))); served += 1
            mint(jobs)                           # every consumer's missing ranges, one model load
            if not served: print(f"no consumer with a seed among {len(cons)} attached; waiting", flush=True)
            if a.once or a.plan_only: return 0
            time.sleep(a.interval); continue

        seed, seed_id, pk, mark = a.seed, a.seed_id, a.pk, a.mark
        ack_floor, acked, finalized = a.ack_floor, (), False
        if a.relay and a.name:
            try:
                info = relay_get(a.relay, f"/v1/pads/pvm?name={a.name}")
            except (urllib.error.HTTPError, urllib.error.URLError, OSError) as e:
                # the pVM detaches whenever the owner app restarts; a 404 here is
                # routine, the bank keeps and the next pass picks up where it was
                code = getattr(e, "code", None) or getattr(e, "reason", e)
                print(f"pVM {a.name} not attached ({code}); waiting", flush=True)
                if a.once: return 1
                time.sleep(a.interval); continue
            seed_id, pk, mark = info["seed_id"], info.get("padKey") or pk, info.get("mark", 0)
            ack_floor, acked, finalized = info.get("ack_floor"), info.get("acked", []), info.get("finalized", False)
            if info.get("issued") is False:
                if a.once: return 0
                time.sleep(a.interval); continue
            if a.master:
                seed, sid = derive_seed(a.master, info["keyFp"], info.get("epoch", a.epoch))
                if sid != seed_id: sys.exit(f"seed id mismatch: relay {seed_id}, derived {sid} (wrong master or epoch?)")
        if not seed_id or mark is None:
            sys.exit("need --relay/--name or --seed-id/--mark")
        serve(seed, seed_id, pk, mark, ack_floor, acked, finalized)
        if a.once or a.plan_only: return 0
        time.sleep(a.interval)

if __name__ == "__main__":
    sys.exit(main())
