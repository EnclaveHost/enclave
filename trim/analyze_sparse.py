"""Per-tensor comparison of an unstructured-pruned checkpoint against google/gemma-4-E2B-it."""
import glob, re, sys, json, collections, torch
from safetensors import safe_open
S = "/home/steven/.cache/huggingface/hub/models--google--gemma-4-E2B-it/snapshots/3e22461f65e89153144f8adb70e3b8c2cc9845a7/"
P = glob.glob(f"/home/steven/.cache/huggingface/hub/models--{sys.argv[1].replace('/', '--')}/snapshots/*/")[0]
fo, fp = safe_open(S+"model.safetensors", "pt"), safe_open(P+"model.safetensors", "pt")
rows = []
for k in sorted(fp.keys()):
    a, b = fo.get_tensor(k), fp.get_tensor(k)
    if a.dim() == 0: a, b = a.reshape(1), b.reshape(1)
    za = zb = 0; identical = nonzero_same = True; d2 = a2 = 0.0
    step = max(1, 100_000_000 // max(1, a[0].numel())) if a.dim() > 1 else a.shape[0]
    for i in range(0, a.shape[0], step):          # chunked so the 2.3G-element tables never get upcast whole
        ca, cb = a[i:i+step], b[i:i+step]
        za += int((ca == 0).sum()); zb += int((cb == 0).sum())
        identical &= torch.equal(ca, cb)
        nz = cb != 0
        nonzero_same &= (torch.equal(ca[nz], cb[nz]) if nz.any() else True)
        cf = ca.float(); d2 += float(((cf - cb.float()) ** 2).sum()); a2 += float((cf ** 2).sum())
    za, zb = za / a.numel(), zb / a.numel(); reld = (d2 / a2) ** 0.5 if a2 else 0.0
    rows.append((k, tuple(b.shape), za, zb, identical, nonzero_same, reld))
def group(k):
    if ".layers." in k and "language_model" in k: return "text." + re.sub(r".*layers\.\d+\.", "", k)
    if "vision_tower" in k: return "vision_tower"
    if "audio_tower" in k: return "audio_tower"
    return k
g = collections.defaultdict(list)
for r in rows: g[group(r[0])].append(r)
print(f"{'tensor group':55s} {'n':>4s} {'zeros orig':>10s} {'zeros now':>10s} {'identical':>9s} {'nz same':>8s} {'rel |d|':>8s}")
for name, rs in sorted(g.items()):
    print(f"{name:55s} {len(rs):4d} {sum(r[2] for r in rs)/len(rs):10.4f} {sum(r[3] for r in rs)/len(rs):10.4f} {sum(r[4] for r in rs):9d} {sum(r[5] for r in rs):8d} {max(r[6] for r in rs):8.4f}")
tot = sum(torch.tensor(r[1]).prod().item() for r in rows); zeros = sum(torch.tensor(r[1]).prod().item() * r[3] for r in rows)
print(f"\noverall zero fraction: {zeros/tot:.4f} of {tot/1e9:.3f} B params; tensors identical to original: {sum(r[4] for r in rows)}/{len(rows)}")
# per-layer sparsity of the text MLP down_proj as a profile across depth
prof = [(int(re.search(r"layers\.(\d+)\.", r[0]).group(1)), r[3]) for r in rows if r[0].endswith("mlp.down_proj.weight") and "language_model" in r[0]]
print("down_proj zero fraction by layer:", [f"{l}:{z:.3f}" for l, z in sorted(prof)])
prof = [(int(re.search(r"layers\.(\d+)\.", r[0]).group(1)), r[3]) for r in rows if r[0].endswith("self_attn.q_proj.weight") and "language_model" in r[0]]
print("q_proj zero fraction by layer:   ", [f"{l}:{z:.3f}" for l, z in sorted(prof)])
# structure of the zeros in one matrix: whole rows/cols (structured) or scattered (unstructured)? N:M pattern?
k = "model.language_model.layers.10.mlp.down_proj.weight"; b = fp.get_tensor(k); z = (b == 0)
print(f"\n{k}: shape {tuple(b.shape)} zero frac {z.float().mean():.4f}; fully-zero rows {int(z.all(1).sum())}, fully-zero cols {int(z.all(0).sum())}")
for M in (4, 8):
    blocks = z.reshape(z.shape[0], -1, M).sum(-1); print(f"   zeros per group of {M} along input dim: histogram {torch.bincount(blocks.flatten(), minlength=M+1).tolist()}")
a = fo.get_tensor(k); thr = a[~z].abs().min().item(); print(f"   min |orig| among survivors {thr:.3e}; max |orig| among zeroed {a[z].abs().max().item() if z.any() else 0:.3e}  (magnitude pruning => survivors' min >= zeroed max)")
json.dump([{"tensor": r[0], "shape": r[1], "zero_frac": r[3], "identical": r[4], "nonzero_same": r[5], "rel_diff": r[6]} for r in rows], open(f"/home/steven/Projects/enclave/trim/artifacts/sparse_{sys.argv[1].split('/')[-1]}.json", "w"), indent=1)
