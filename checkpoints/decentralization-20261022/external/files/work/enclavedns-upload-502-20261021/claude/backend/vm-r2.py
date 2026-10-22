import subprocess,json,os,re,datetime
# READ-ONLY. Aggregates only: counts/timestamps; no keys, no object content, no full rows, no config/env.
SINCE="2026-10-21 18:20+00"
TIP="(SELECT max(settings_tip_height) FROM hosts)"
GOODH=f"(SELECT DISTINCT host_id FROM contracts WHERE good AND expiration_height > {TIP})"
Q={
 'db_now':"SELECT now()",
 'sectors_by_minute_since_1820':f"SELECT coalesce(string_agg(m||'='||n, ' ' ORDER BY m),'none') FROM (SELECT to_char(date_trunc('minute',uploaded_at),'HH24:MI') m,count(*) n FROM sectors WHERE uploaded_at>'{SINCE}' GROUP BY 1) x",
 'slabs_pinned_by_minute_since_1820':f"SELECT coalesce(string_agg(m||'='||n, ' ' ORDER BY m),'none') FROM (SELECT to_char(date_trunc('minute',pinned_at),'HH24:MI:SS') m,count(*) n FROM slabs WHERE pinned_at>'{SINCE}' GROUP BY 1) x",
 'objects_since_1820':f"SELECT count(*) FROM objects WHERE created_at>'{SINCE}' OR updated_at>'{SINCE}'",
 'objects_last':"SELECT max(greatest(created_at,updated_at)) FROM objects",
 'distinct_hosts_good_unexpired_contract':f"SELECT count(*) FROM {GOODH} g",
 'of_those_siamux':f"SELECT count(*) FROM hosts WHERE id IN {GOODH} AND has_siamux",
 'of_those_accepting':f"SELECT count(*) FROM hosts WHERE id IN {GOODH} AND settings_accepting_contracts",
 'of_those_remaining_storage_gt_0':f"SELECT count(*) FROM hosts WHERE id IN {GOODH} AND settings_remaining_storage>0",
 'of_those_scan_ok_1h':f"SELECT count(*) FROM hosts WHERE id IN {GOODH} AND last_successful_scan > now()-interval '1 hour'",
 'of_those_consecutive_failed_scans_gt_0':f"SELECT count(*) FROM hosts WHERE id IN {GOODH} AND consecutive_failed_scans>0",
 'of_those_lost_sectors_gt_0':f"SELECT count(*) FROM hosts WHERE id IN {GOODH} AND lost_sectors>0",
 'good_unexpired_capacity_minus_size_min_max_GiB':f"SELECT round(min(capacity-size)/1073741824.0,2)||'/'||round(max(capacity-size)/1073741824.0,2) FROM contracts WHERE good AND expiration_height > {TIP}",
 'good_unexpired_contracts_remaining_allowance_zero':f"SELECT count(*) FROM contracts WHERE good AND expiration_height > {TIP} AND remaining_allowance<=0",
 'blocks_to_nearest_good_expiry':f"SELECT min(expiration_height)-{TIP} FROM contracts WHERE good AND expiration_height > {TIP}",
 'distinct_hosts_in_1803_slab':"SELECT count(DISTINCT s.host_id) FROM sectors s WHERE s.uploaded_at BETWEEN '2026-10-21 18:03:00+00' AND '2026-10-21 18:03:59+00'",
 'tip_height':f"SELECT {TIP}",
}
out={}
for k,q in Q.items():
    p=subprocess.run(['docker','exec','enclave-indexd-postgres','psql','-U','postgres','-d','indexd','-Atq','-c',q],text=True,capture_output=True)
    out[k]=(p.stdout.strip() or p.stderr.strip()[:200])
# indexd/caddy journals and indexd file log since 18:23: counts and digit-stripped message templates only
def journal(unit):
    p=subprocess.run(['journalctl','-u',unit,'--since','2026-10-21 18:23:00 UTC','-o','cat','--no-pager'],text=True,capture_output=True)
    lines=[l for l in p.stdout.splitlines() if l.strip() and not l.startswith('-- ')]
    return lines
def templ(lines):
    t={}
    for l in lines:
        k=re.sub(r'[0-9a-fA-F]{8,}','<h>',re.sub(r'\d+','<n>',l))[:140]
        t[k]=t.get(k,0)+1
    return sorted(t.items(),key=lambda x:-x[1])[:12]
for u in ('enclave-indexd','caddy'):
    ls=journal(u); out[f'journal_{u}_lines_since_1823']=len(ls)
    out[f'journal_{u}_levels']={lv:sum(1 for l in ls if lv in l.lower()) for lv in ('error','warn','info','debug')}
    out[f'journal_{u}_templates']=templ([l for l in ls if re.search('error|warn|fail|timeout',l,re.I)])
f='/var/lib/enclave-indexd/state/logs/indexd.log'
if os.path.isfile(f):
    st=os.stat(f); out['indexd_file']={'bytes':st.st_size,'mtime':datetime.datetime.fromtimestamp(st.st_mtime,datetime.timezone.utc).isoformat()}
print(json.dumps(out,indent=1))
