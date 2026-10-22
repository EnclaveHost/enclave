import subprocess,json
# READ-ONLY. Timestamps/counts only.
Q={
 'sectors_18h_min_max':"SELECT min(uploaded_at)||' .. '||max(uploaded_at) FROM sectors WHERE uploaded_at>='2026-10-21 18:00+00'",
 'sectors_18h_by_10s':"SELECT string_agg(t||'='||n,' ' ORDER BY t) FROM (SELECT to_char(date_trunc('minute',uploaded_at)+floor(extract(second FROM uploaded_at)/10)*interval '10 s','HH24:MI:SS') t,count(*) n FROM sectors WHERE uploaded_at>='2026-10-21 18:00+00' GROUP BY 1) x",
 'sectors_18h_distinct_hosts':"SELECT count(DISTINCT host_id) FROM sectors WHERE uploaded_at>='2026-10-21 18:00+00'",
 'sectors_15h_min_max':"SELECT min(uploaded_at)||' .. '||max(uploaded_at) FROM sectors WHERE uploaded_at BETWEEN '2026-10-21 15:00+00' AND '2026-10-21 15:59:59+00'",
 'slab_15h_pinned':"SELECT min(pinned_at) FROM slabs WHERE pinned_at BETWEEN '2026-10-21 15:00+00' AND '2026-10-21 15:59:59+00'",
 'objects_15h_created':"SELECT min(created_at) FROM objects WHERE created_at BETWEEN '2026-10-21 15:00+00' AND '2026-10-21 15:59:59+00'",
}
out={}
for k,q in Q.items():
    p=subprocess.run(['docker','exec','enclave-indexd-postgres','psql','-U','postgres','-d','indexd','-Atq','-c',q],text=True,capture_output=True)
    out[k]=(p.stdout.strip() or p.stderr.strip()[:200])
print(json.dumps(out,indent=1))
