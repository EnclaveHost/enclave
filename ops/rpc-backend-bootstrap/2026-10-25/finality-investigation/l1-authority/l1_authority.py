#!/usr/bin/env python3
"""L1 light-client authority launcher around the PINNED Helios executable (finality-stage/l1-authority, README.md).

  l1_authority.py check  CONFIG     validate config + checkpoint record + binary pin; print the exact argv/env (no exec)
  l1_authority.py run    CONFIG     the same checks, then exec the pinned binary from the hashed file descriptor
  l1_authority.py status CONFIG     ask the local Helios RPC for finalized/latest and label freshness (exit 0 only if fresh)

The cryptography (bootstrap root == checkpoint, sync-committee BLS signatures, >= 2/3 participation for finality,
finality and execution-payload Merkle branches, execution block hash recomputation) is done by Helios itself
(helios ethereum/consensus-core, core/src/client/node.rs). This wrapper only removes every input the pinned CLI would
otherwise take from defaults, files or the environment, and refuses configs that could reach anything but our own
loopback Lighthouse and EL. It never labels anything finalized from its own checks.
Python stdlib only.
"""
import hashlib, ipaddress, json, os, re, stat, sys, time, urllib.parse, urllib.request

FORMAT = "enclave-l1-authority/v1"
CHECKPOINT_FORMAT = "enclave-l1-checkpoint/v1"
# Ethereum mainnet beacon genesis time and slot length (consensus specs; Helios ethereum/src/config/networks.rs mainnet).
MAINNET_GENESIS_TIME = 1606824023
SECONDS_PER_SLOT = 12
HELIOS_MAX_CHECKPOINT_AGE = 1_209_600          # mainnet max_checkpoint_age in the pinned networks.rs (14 days)
CONFIG_KEYS = {"format", "network", "binary", "consensusRpc", "executionRpc", "listen", "dataDir", "homeDir",
               "checkpointFile", "maxCheckpointAgeSec", "maxFinalizedAgeSec", "logFilter"}
SOURCE_KINDS = {"own-lighthouse", "independent-beacon-node", "checkpoint-sync-provider", "block-explorer", "operator-attestation"}
HEX32 = re.compile(r"^0x[0-9a-f]{64}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
LOG_FILTER = re.compile(r"^(error|warn|info|debug)(,[a-z_:]+=(error|warn|info|debug))*$")


class Refused(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def refuse(code, message):
    raise Refused(code, message)


def only(obj, keys, what):
    if not isinstance(obj, dict):
        refuse("bad-config", f"{what} must be an object")
    extra = set(obj) - set(keys)
    if extra:
        refuse("unknown-field", f"{what} has unsupported fields {sorted(extra)} (no fallback/verifiable-api/override knobs exist)")


def loopback_url(value, what):
    """http://<literal loopback IP>:<port> with no path, credentials, query or fragment. Hostnames are refused (no DNS)."""
    if not isinstance(value, str):
        refuse("bad-url", f"{what} must be a string")
    u = urllib.parse.urlsplit(value)
    if u.scheme != "http":
        refuse("bad-url", f"{what} must be plain http to a loopback literal (got scheme {u.scheme!r})")
    if u.username or u.password or u.query or u.fragment or u.path not in ("", "/"):
        refuse("bad-url", f"{what} must have no credentials, path, query or fragment")
    try:
        ip = ipaddress.ip_address(u.hostname or "")
    except ValueError:
        refuse("not-loopback", f"{what} host must be a literal loopback IP, not a name")
    if not ip.is_loopback:
        refuse("not-loopback", f"{what} host {ip} is not loopback")
    if u.port is None or not (1 <= u.port <= 65535):
        refuse("bad-url", f"{what} needs an explicit port")
    return f"http://{u.hostname if ip.version == 4 else '[' + u.hostname + ']'}:{u.port}", str(ip), u.port


def private_dir(path, what):
    if not isinstance(path, str) or not os.path.isabs(path) or os.path.normpath(path) != path:
        refuse("bad-path", f"{what} must be an absolute normalized path")
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        refuse("bad-path", f"{what} {path} does not exist (create it 0700 first)")
    if not stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode):
        refuse("bad-path", f"{what} must be a real directory")
    if st.st_uid != os.geteuid() or st.st_mode & 0o077:
        refuse("bad-path", f"{what} must be owned by this user with mode 0700")
    return path


def slot_age(slot, now):
    return now - (MAINNET_GENESIS_TIME + slot * SECONDS_PER_SLOT)


def load_checkpoint(path, network, max_age, now):
    if not isinstance(path, str) or not os.path.isabs(path):
        refuse("bad-path", "checkpointFile must be an absolute path")
    try:
        with open(path, "rb") as f:
            raw = f.read(65537)
    except OSError as e:
        refuse("no-checkpoint", f"checkpoint record unreadable: {e}")
    if len(raw) > 65536:
        refuse("bad-checkpoint", "checkpoint record too large")
    try:
        rec = json.loads(raw)
    except ValueError:
        refuse("bad-checkpoint", "checkpoint record is not JSON")
    only(rec, {"format", "network", "root", "slot", "sources", "recordedAt"}, "checkpoint record")
    if rec.get("format") != CHECKPOINT_FORMAT or rec.get("network") != network:
        refuse("bad-checkpoint", "checkpoint record format/network mismatch")
    root = rec.get("root")
    if not isinstance(root, str) or not HEX32.match(root) or root == "0x" + "0" * 64:
        refuse("bad-checkpoint", "checkpoint root must be a lowercase 32-byte hex beacon block root")
    slot = rec.get("slot")
    if not isinstance(slot, int) or isinstance(slot, bool) or slot < 0 or slot % 32 != 0:
        refuse("bad-checkpoint", "checkpoint slot must be an epoch-boundary slot number")
    age = slot_age(slot, now)
    if age < 0:
        refuse("checkpoint-future", "checkpoint slot is in the future")
    if age > max_age:
        refuse("checkpoint-too-old", f"declared checkpoint slot is {age} s old (max {max_age})")
    sources = rec.get("sources")
    if not isinstance(sources, list) or len(sources) < 2:
        refuse("weak-provenance", "a checkpoint needs at least two provenance sources")
    seen = set()
    for s in sources:
        only(s, {"kind", "ref", "observedAt"}, "checkpoint source")
        if s.get("kind") not in SOURCE_KINDS or not isinstance(s.get("ref"), str) or not s["ref"] or not isinstance(s.get("observedAt"), str):
            refuse("weak-provenance", "each source needs a known kind, a ref and observedAt")
        seen.add((s["kind"], s["ref"]))
    if len(seen) != len(sources):
        refuse("weak-provenance", "duplicate provenance sources")
    if all(s["kind"] == "own-lighthouse" for s in sources):
        refuse("weak-provenance", "provenance cannot be only our own beacon node")
    return {"root": root, "slot": slot, "declaredAgeSec": age, "sources": len(sources)}


def load_config(path, now=None):
    now = int(time.time()) if now is None else now
    try:
        with open(path, "rb") as f:
            cfg = json.loads(f.read(65537))
    except (OSError, ValueError) as e:
        refuse("bad-config", f"config unreadable: {e}")
    only(cfg, CONFIG_KEYS, "config")
    missing = CONFIG_KEYS - set(cfg)
    if missing:
        refuse("bad-config", f"config misses {sorted(missing)}")
    if cfg["format"] != FORMAT:
        refuse("bad-config", "unsupported config format")
    if cfg["network"] != "mainnet":
        refuse("bad-config", "only mainnet is packaged")
    only(cfg["binary"], {"path", "sha256"}, "binary")
    if not isinstance(cfg["binary"].get("path"), str) or not os.path.isabs(cfg["binary"]["path"]) or not SHA256.match(str(cfg["binary"].get("sha256"))):
        refuse("bad-config", "binary needs an absolute path and a sha256 pin")
    consensus, c_ip, c_port = loopback_url(cfg["consensusRpc"], "consensusRpc")
    execution, e_ip, e_port = loopback_url(cfg["executionRpc"], "executionRpc")
    only(cfg["listen"], {"ip", "port"}, "listen")
    try:
        lip = ipaddress.ip_address(str(cfg["listen"].get("ip")))
    except ValueError:
        refuse("not-loopback", "listen.ip must be a literal IP")
    if not lip.is_loopback:
        refuse("not-loopback", "listen.ip must be loopback")
    lport = cfg["listen"].get("port")
    if not isinstance(lport, int) or isinstance(lport, bool) or not (1024 <= lport <= 65535):
        refuse("bad-config", "listen.port must be 1024-65535")
    ends = {(c_ip, c_port), (e_ip, e_port), (str(lip), lport)}
    if len(ends) != 3:
        refuse("bad-config", "consensus, execution and listen endpoints must be distinct")
    max_cp = cfg["maxCheckpointAgeSec"]
    if not isinstance(max_cp, int) or isinstance(max_cp, bool) or not (3600 <= max_cp <= HELIOS_MAX_CHECKPOINT_AGE):
        refuse("bad-config", f"maxCheckpointAgeSec must be 3600..{HELIOS_MAX_CHECKPOINT_AGE} (Helios strict age cannot be raised)")
    max_fin = cfg["maxFinalizedAgeSec"]
    if not isinstance(max_fin, int) or isinstance(max_fin, bool) or not (900 <= max_fin <= 7200):
        refuse("bad-config", "maxFinalizedAgeSec must be 900..7200")
    if not isinstance(cfg["logFilter"], str) or not LOG_FILTER.match(cfg["logFilter"]):
        refuse("bad-config", "logFilter must be a plain level filter")
    data_dir = private_dir(cfg["dataDir"], "dataDir")
    home = private_dir(cfg["homeDir"], "homeDir")
    if data_dir == home or data_dir.startswith(home + "/") or home.startswith(data_dir + "/"):
        refuse("bad-config", "dataDir and homeDir must be separate")
    if os.path.lexists(os.path.join(home, ".helios")):
        refuse("home-config-present", "homeDir/.helios exists: the pinned CLI would merge helios.toml from it")
    cp = load_checkpoint(cfg["checkpointFile"], cfg["network"], max_cp, now)
    return {"cfg": cfg, "consensus": consensus, "execution": execution, "listenIp": str(lip), "listenPort": lport,
            "dataDir": data_dir, "home": home, "checkpoint": cp}


def build_exec(c):
    """The complete argv and env. Every CLI input the pinned binary would otherwise default is given explicitly; the env
    is REPLACED (clap reads CONSENSUS_RPC, FALLBACK, LOAD_EXTERNAL_FALLBACK, ... from the environment)."""
    argv = ["helios", "ethereum", "--network", "mainnet",
            "--consensus-rpc", c["consensus"], "--execution-rpc", c["execution"],
            "--checkpoint", c["checkpoint"]["root"], "--data-dir", c["dataDir"],
            "--rpc-bind-ip", c["listenIp"], "--rpc-port", str(c["listenPort"]),
            "--strict-checkpoint-age"]
    env = {"HOME": c["home"], "RUST_LOG": c["cfg"]["logFilter"]}
    return argv, env


def open_pinned(binary):
    """Open once, hash that open file, and exec from the same descriptor (no path TOCTOU)."""
    fd = os.open(binary["path"], os.O_RDONLY | os.O_CLOEXEC)
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode):
        os.close(fd); refuse("binary-pin", "binary is not a regular file")
    h = hashlib.sha256()
    while True:
        b = os.read(fd, 1 << 20)
        if not b:
            break
        h.update(b)
    if h.hexdigest() != binary["sha256"]:
        os.close(fd); refuse("binary-pin", f"binary sha256 {h.hexdigest()} != pin {binary['sha256']}")
    return fd


def rpc(url, method, params, rid, timeout=5.0, max_bytes=1 << 20):
    req = urllib.request.Request(url, data=json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}).encode(),
                                 headers={"content-type": "application/json"}, method="POST")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))      # never an env proxy
    with opener.open(req, timeout=timeout) as r:
        body = r.read(max_bytes + 1)
    if len(body) > max_bytes:
        refuse("bad-answer", "reply too large")
    try:
        j = json.loads(body)
    except ValueError:
        refuse("bad-answer", f"{method}: not JSON")
    if not isinstance(j, dict) or j.get("jsonrpc") != "2.0" or j.get("id") != rid or (("result" in j) == ("error" in j)):
        refuse("bad-answer", f"{method}: not a JSON-RPC 2.0 reply to this request")
    if "error" in j:
        refuse("not-ready", f"{method}: {str(j['error'])[:160]}")
    return j["result"]


def qty(v, what):
    if not isinstance(v, str) or not re.match(r"^0x(0|[1-9a-f][0-9a-f]*)$", v):
        refuse("bad-answer", f"{what} is not a quantity")
    return int(v, 16)


def block_summary(b, what):
    if not isinstance(b, dict):
        refuse("not-ready", f"no {what} block")
    h = b.get("hash")
    if not isinstance(h, str) or not HEX32.match(h):
        refuse("bad-answer", f"{what} block hash malformed")
    return {"number": qty(b.get("number"), f"{what} number"), "hash": h, "timestamp": qty(b.get("timestamp"), f"{what} timestamp")}


def status(c, now=None):
    url = f"http://{c['listenIp'] if ':' not in c['listenIp'] else '[' + c['listenIp'] + ']'}:{c['listenPort']}"
    if qty(rpc(url, "eth_chainId", [], 1), "chain id") != 1:
        refuse("wrong-chain", "local Helios is not on chain 1")
    fin = block_summary(rpc(url, "eth_getBlockByNumber", ["finalized", False], 2), "finalized")
    lat = block_summary(rpc(url, "eth_getBlockByNumber", ["latest", False], 3), "latest")
    now = int(time.time()) if now is None else now
    if fin["number"] > lat["number"] or fin["timestamp"] > lat["timestamp"]:
        refuse("incoherent", "finalized is above latest")
    if fin["timestamp"] > now + 15:
        refuse("incoherent", "finalized block is in the future")
    age = now - fin["timestamp"]
    if age > c["cfg"]["maxFinalizedAgeSec"]:
        refuse("stale-finality", f"finalized block is {age} s old (max {c['cfg']['maxFinalizedAgeSec']})")
    return {"verdict": "fresh-finalized",
            "authority": "helios-ethereum-light-client",
            "finalizedBasis": "sync-committee supermajority (>=2/3) finality update verified inside pinned Helios",
            "latestBasis": "optimistic header (sync-committee signed, NOT finalized); Helios refuses latest >60 s old",
            "wrapperChecks": "chain id, JSON-RPC envelope, finalized<=latest, finalized age; the wrapper adds no proof",
            "binarySha256": c["cfg"]["binary"]["sha256"], "checkpoint": c["checkpoint"],
            "finalized": dict(fin, ageSec=age), "latest": lat}


def main(argv):
    if len(argv) != 3 or argv[1] not in ("check", "run", "status"):
        print(__doc__, file=sys.stderr)
        return 2
    try:
        c = load_config(argv[2])
        if argv[1] == "status":
            print(json.dumps(status(c), sort_keys=True))
            return 0
        fd = open_pinned(c["cfg"]["binary"])
        args, env = build_exec(c)
        if argv[1] == "check":
            os.close(fd)
            print(json.dumps({"ok": True, "argv": args, "env": env, "checkpoint": c["checkpoint"]}, sort_keys=True))
            return 0
        sys.stdout.flush(); sys.stderr.flush()
        os.execve(f"/proc/self/fd/{fd}", args, env)
    except Refused as e:
        print(json.dumps({"ok": False, "code": e.code, "message": str(e)}, sort_keys=True))
        return 3
    except OSError as e:
        print(json.dumps({"ok": False, "code": "unavailable", "message": str(e)[:200]}, sort_keys=True))
        return 4


if __name__ == "__main__":
    sys.exit(main(sys.argv))
