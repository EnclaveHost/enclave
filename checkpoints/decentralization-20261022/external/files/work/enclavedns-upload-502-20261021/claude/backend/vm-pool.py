import subprocess,json
# READ-ONLY. Counts only; no keys.
A="(SELECT id FROM accounts WHERE name='sia-s3' AND deleted_at IS NULL)"
P="(SELECT id FROM pools WHERE connect_key_id IN (SELECT connect_key_id FROM accounts WHERE id IN "+A+"))"
TIP="(SELECT max(settings_tip_height) FROM hosts)"
GOODH=f"(SELECT DISTINCT host_id FROM contracts WHERE good AND expiration_height > {TIP})"
OFFER=f"(SELECT DISTINCT host_id FROM contracts WHERE state IN (0,1) AND renewed_to IS NULL AND good AND proof_height > (SELECT scanned_height FROM global_settings))"
Q={
 'db_now':"SELECT now()",
 'offerable_hosts_contract_clause':f"SELECT count(*) FROM {OFFER} o",
 'offerable_and_not_stuck_remaining_gt0':f"SELECT count(*) FROM hosts WHERE id IN {OFFER} AND stuck_since IS NULL AND settings_remaining_storage>0",
 'offerable_blocklisted':f"SELECT count(*) FROM hosts h JOIN hosts_blocklist b ON b.public_key=h.public_key WHERE h.id IN {OFFER}",
 'offerable_without_pool_host_row':f"SELECT count(*) FROM {OFFER} o WHERE o.host_id NOT IN (SELECT host_id FROM pool_hosts WHERE pool_id IN {P})",
 'offerable_pool_failed_gt0':f"SELECT count(*) FROM pool_hosts WHERE pool_id IN {P} AND host_id IN {OFFER} AND consecutive_failed_funds>0",
 'offerable_without_attachment':f"SELECT count(*) FROM {OFFER} o WHERE o.host_id NOT IN (SELECT host_id FROM pool_attachments WHERE account_id IN {A})",
 'offerable_pool_next_fund_overdue_gt10min':f"SELECT count(*) FROM pool_hosts WHERE pool_id IN {P} AND host_id IN {OFFER} AND next_fund < now()-interval '10 minutes'",
 'offerable_pool_next_fund_min_max':f"SELECT min(next_fund)||' .. '||max(next_fund) FROM pool_hosts WHERE pool_id IN {P} AND host_id IN {OFFER}",
 'sectors_1803_total_nullhost_distinct':"SELECT count(*)||' / '||count(*) FILTER (WHERE host_id IS NULL)||' / '||count(DISTINCT host_id) FROM sectors WHERE uploaded_at BETWEEN '2026-10-21 18:03:00+00' AND '2026-10-21 18:03:59+00'",
 'sectors_1500h_total_nullhost_distinct':"SELECT count(*)||' / '||count(*) FILTER (WHERE host_id IS NULL)||' / '||count(DISTINCT host_id) FROM sectors WHERE uploaded_at BETWEEN '2026-10-21 15:00:00+00' AND '2026-10-21 15:59:59+00'",
 'sectors_null_host_total':"SELECT count(*) FROM sectors WHERE host_id IS NULL",
}
out={}
for k,q in Q.items():
    p=subprocess.run(['docker','exec','enclave-indexd-postgres','psql','-U','postgres','-d','indexd','-Atq','-c',q],text=True,capture_output=True)
    out[k]=(p.stdout.strip() or p.stderr.strip()[:200])
print(json.dumps(out,indent=1))
