import subprocess
q="SELECT table_name||'.'||string_agg(column_name||':'||data_type, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('objects','slabs','contracts','accounts','hosts','sectors','slab_sectors','object_slabs') GROUP BY table_name;"
p=subprocess.run(['docker','exec','enclave-indexd-postgres','psql','-U','postgres','-d','indexd','-Atq','-c',q],text=True,capture_output=True)
print(p.stdout[:6000]); print(p.stderr[:300])
