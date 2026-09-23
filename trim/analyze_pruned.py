"""Match every tensor of FlameF0X/gemma-4-E2B-it-pruned against google/gemma-4-E2B-it to see what was done."""
import glob, re, json, collections, torch
from safetensors import safe_open
S = "/home/steven/.cache/huggingface/hub/models--google--gemma-4-E2B-it/snapshots/3e22461f65e89153144f8adb70e3b8c2cc9845a7/"
P = glob.glob("/home/steven/.cache/huggingface/hub/models--FlameF0X--gemma-4-E2B-it-pruned/snapshots/*/")[0]
fo, fp = safe_open(S+"model.safetensors", "pt"), safe_open(P+"model.safetensors", "pt")
ko, kp = set(fo.keys()), set(fp.keys())
print("tensors: original", len(ko), "pruned", len(kp))
print("pruned-only keys:", sorted(kp-ko)[:20])
# --- non-layer tensors: exact equality with the original?
same = diff = 0; changed = []
for k in sorted(kp & ko):
    if ".layers." in k and "language_model" in k: continue
    a, b = fo.get_tensor(k), fp.get_tensor(k)
    if a.shape == b.shape and torch.equal(a, b): same += 1
    else:
        diff += 1; changed.append((k, tuple(a.shape), tuple(b.shape), (a.float()-b.float()).abs().max().item() if a.shape == b.shape else None))
print(f"non-layer tensors shared with the original: identical {same}, different {diff}")
for c in changed[:20]: print("   changed:", c)
# --- text layers: for each pruned layer find the original layer with identical weights
lay_p = sorted({int(m.group(1)) for k in kp if (m := re.search(r"language_model\.layers\.(\d+)\.", k))})
lay_o = sorted({int(m.group(1)) for k in ko if (m := re.search(r"language_model\.layers\.(\d+)\.", k))})
print("pruned layer indices:", lay_p)
mapping = {}
for i in lay_p:
    names = sorted(k for k in kp if f"language_model.layers.{i}." in k)
    probe = [n for n in names if n.endswith("mlp.down_proj.weight")][0]
    b = fp.get_tensor(probe)
    best = None
    for j in lay_o:
        a = fo.get_tensor(probe.replace(f".layers.{i}.", f".layers.{j}."))
        if a.shape != b.shape: continue
        if torch.equal(a, b): best = (j, 0.0); break
        d = (a.float()-b.float()).abs().max().item()
        if best is None or d < best[1]: best = (j, d)
    j, d = best
    # full-layer comparison against that source layer
    n_same = n_diff = n_missing = 0; maxd = 0.0; shape_changes = []
    for n in names:
        src = n.replace(f".layers.{i}.", f".layers.{j}.")
        if src not in ko: n_missing += 1; continue
        a, bb = fo.get_tensor(src), fp.get_tensor(n)
        if a.shape != bb.shape: shape_changes.append((n.split(f"layers.{i}.")[1], tuple(a.shape), tuple(bb.shape))); n_diff += 1; continue
        if torch.equal(a, bb): n_same += 1
        else: n_diff += 1; maxd = max(maxd, (a.float()-bb.float()).abs().max().item())
    orig_names = {k.split(f"layers.{j}.")[1] for k in ko if f"language_model.layers.{j}." in k}
    pr_names = {n.split(f"layers.{i}.")[1] for n in names}
    mapping[i] = j
    print(f"pruned layer {i:2d} <- original layer {j:2d}: {n_same} tensors identical, {n_diff} differ (max|d|={maxd:.4g}), "
          f"missing-in-orig {n_missing}; tensors dropped vs original layer: {sorted(orig_names-pr_names)}; shape changes: {shape_changes}")
# --- per-layer embedding table: which 256-wide column blocks were kept?
a, b = fo.get_tensor("model.language_model.embed_tokens_per_layer.weight"), fp.get_tensor("model.language_model.embed_tokens_per_layer.weight")
print("embed_tokens_per_layer:", tuple(a.shape), "->", tuple(b.shape))
rows = torch.arange(0, a.shape[0], 997)  # sample rows
for blk in range(b.shape[1] // 256):
    bb = b[rows, blk*256:(blk+1)*256]
    src = [j for j in range(a.shape[1] // 256) if torch.equal(a[rows, j*256:(j+1)*256], bb)]
    print(f"   PLE block {blk} == original layer block {src}")
e_o, e_p = fo.get_tensor("model.language_model.embed_tokens.weight"), fp.get_tensor("model.language_model.embed_tokens.weight")
print("embed_tokens identical:", torch.equal(e_o, e_p), tuple(e_p.shape))
json.dump({"layer_map": mapping}, open("/home/steven/Projects/enclave/trim/artifacts/pruned_layer_map.json", "w"))
