import subprocess,json
Q={'slabs_pinned_since_18':"SELECT count(*) FROM slabs WHERE pinned_at>'2026-10-21 18:00+00'",
   'of_them_referenced_by_an_object':"SELECT count(*) FROM slabs s WHERE s.pinned_at>'2026-10-21 18:00+00' AND EXISTS (SELECT 1 FROM object_slabs o WHERE o.slab_digest=s.digest)",
   'slab_15_referenced':"SELECT count(*) FROM slabs s WHERE s.pinned_at BETWEEN '2026-10-21 15:00+00' AND '2026-10-21 16:00+00' AND EXISTS (SELECT 1 FROM object_slabs o WHERE o.slab_digest=s.digest)"}
out={}
for k,q in Q.items():
    p=subprocess.run(['docker','exec','enclave-indexd-postgres','psql','-U','postgres','-d','indexd','-Atq','-c',q],text=True,capture_output=True)
    out[k]=(p.stdout.strip() or p.stderr.strip()[:200])
print(json.dumps(out))
