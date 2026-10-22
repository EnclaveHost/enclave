#!/usr/bin/env python3
"""fake_docker.py - a MOCK docker CLI for test/test_ownership.py. It never talks to a docker daemon. State is a JSON file
($FAKEDOCKER_STATE: {"containers": {name: {"labels": {...}, "volume": v}}, "volumes": {name: {"labels": {...}}}}), every call is
appended to $FAKEDOCKER_LOG, and faults come from $FAKEDOCKER_FAULT (comma list):
  lose-volume-create  create the volume, then answer rc 1 (the response is lost)
  lose-run            create the container, then answer rc 1 ("context deadline exceeded")
  slow-run            create the container, then sleep 5 s (the caller's timeout fires: a lost response)
  lose-rm             remove the container, then answer rc 1
  rm-fails            do not remove the container, answer rc 1
  inspect-error       every inspect answers "Cannot connect to the Docker daemon" (rc 1)
  port-public         `docker port` answers 0.0.0.0:<port>
Behaves like docker where it matters: `volume create` on an existing name returns it unchanged (labels NOT applied);
`run --name` on an existing name is a 125 Conflict; `volume rm` of a volume in use fails."""
import json
import os
import sys
import time

S, LOG = os.environ["FAKEDOCKER_STATE"], os.environ["FAKEDOCKER_LOG"]
FAULT = set(filter(None, os.environ.get("FAKEDOCKER_FAULT", "").split(",")))
a = sys.argv[1:]
with open(LOG, "a") as f:
    f.write(json.dumps(a) + "\n")
st = json.load(open(S)) if os.path.exists(S) else {"containers": {}, "volumes": {}}


def save():
    json.dump(st, open(S, "w"))


def labels_of(args):
    out = {}
    for i, x in enumerate(args):
        if x == "--label":
            k, v = args[i + 1].split("=", 1)
            out[k] = v
    return out


def done(rc=0, out="", err=""):
    sys.stdout.write(out)
    sys.stderr.write(err)
    sys.exit(rc)


if a[:1] in (["container"], ["volume"]) and a[1:2] == ["inspect"]:
    kind, name = a[0], a[-1]
    if "inspect-error" in FAULT:
        done(1, err="Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n")
    obj = st["containers" if kind == "container" else "volumes"].get(name)
    if obj is None:
        done(1, err=f"Error response from daemon: No such {kind}: {name}\n")
    done(0, json.dumps(obj["labels"] or None) + "\n")
if a[:2] == ["volume", "create"]:
    name = a[-1]
    if name not in st["volumes"]:
        st["volumes"][name] = {"labels": labels_of(a)}
        save()
    if "lose-volume-create" in FAULT:
        done(1, err="error during connect: EOF\n")
    done(0, name + "\n")
if a[:2] == ["volume", "rm"]:
    name = a[-1]
    if name not in st["volumes"]:
        done(1, err=f"Error: No such volume: {name}\n")
    if any(c.get("volume") == name for c in st["containers"].values()):
        done(1, err="volume is in use\n")
    del st["volumes"][name]
    save()
    done(0, name + "\n")
if a[:1] == ["run"]:
    name = a[a.index("--name") + 1]
    if name in st["containers"]:
        done(125, err=f'docker: Error response from daemon: Conflict. The container name "/{name}" is already in use.\n')
    mount = a[a.index("--mount") + 1]
    vol = dict(kv.split("=", 1) for kv in mount.split(","))["source"]
    st["containers"][name] = {"labels": labels_of(a), "volume": vol, "args": a}
    save()
    if "slow-run" in FAULT:
        time.sleep(5)
    if "lose-run" in FAULT:
        done(1, err="context deadline exceeded\n")
    done(0, "f" * 64 + "\n")
if a[:2] == ["rm", "-f"]:
    name = a[-1]
    if "rm-fails" in FAULT:
        done(1, err="Error response from daemon: removal in progress\n")
    st["containers"].pop(name, None)
    save()
    if "lose-rm" in FAULT:
        done(1, err="error during connect: EOF\n")
    done(0, name + "\n")
if a[:1] == ["port"]:
    done(0, ("0.0.0.0" if "port-public" in FAULT else "127.0.0.1") + ":55999\n")
if a[:1] == ["exec"]:
    done(0)
done(2, err=f"fake docker: unsupported {a}\n")
