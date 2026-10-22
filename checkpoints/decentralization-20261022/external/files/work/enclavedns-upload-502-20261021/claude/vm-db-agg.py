import subprocess,json
Q={
 'objects_last':"SELECT max(created_at) FROM objects",
 'sectors_last_upload':"SELECT max(uploaded_at) FROM sectors",
 'slabs_last_pinned':"SELECT max(pinned_at) FROM slabs",
 'sectors_per_hour':"SELECT string_agg(h||'='||n, ' ' ORDER BY h) FROM (SELECT to_char(date_trunc('hour',uploaded_at),'HH24') h,count(*) n FROM sectors WHERE uploaded_at>'2026-10-21 12:00+00' GROUP BY 1) x",
 'objects_per_hour':"SELECT string_agg(h||'='||n, ' ' ORDER BY h) FROM (SELECT to_char(date_trunc('hour',created_at),'HH24') h,count(*) n FROM objects WHERE created_at>'2026-10-21 12:00+00' GROUP BY 1) x",
 'slabs_pinned_per_hour':"SELECT string_agg(h||'='||n, ' ' ORDER BY h) FROM (SELECT to_char(date_trunc('hour',pinned_at),'HH24') h,count(*) n FROM slabs WHERE pinned_at>'2026-10-21 12:00+00' GROUP BY 1) x",
 'contracts_by_state_good':"SELECT string_agg(state||'/'||good||'='||n, ' ') FROM (SELECT state,good,count(*) n FROM contracts GROUP BY 1,2) x",
 'tip_height':"SELECT max(settings_tip_height) FROM hosts",
 'good_contracts_unexpired':"SELECT count(*) FROM contracts WHERE good AND expiration_height > (SELECT max(settings_tip_height) FROM hosts)",
 'hosts_scanned_ok_1h':"SELECT count(*) FROM hosts WHERE last_successful_scan > now()-interval '1 hour'",
 'hosts_stuck':"SELECT count(*) FROM hosts WHERE stuck_since IS NOT NULL",
 'hosts_failed_scan_1h':"SELECT count(*) FROM hosts WHERE last_failed_scan > now()-interval '1 hour'",
 'slabs_unrecoverable':"SELECT count(*) FROM slabs WHERE unrecoverable_since IS NOT NULL",
 'accounts_last_used':"SELECT max(last_used) FROM accounts",
 'db_now':"SELECT now()",
}
out={}
for k,q in Q.items():
    p=subprocess.run(['docker','exec','enclave-indexd-postgres','psql','-U','postgres','-d','indexd','-Atq','-c',q],text=True,capture_output=True)
    out[k]=(p.stdout.strip() or p.stderr.strip()[:200])
print(json.dumps(out,indent=1))
