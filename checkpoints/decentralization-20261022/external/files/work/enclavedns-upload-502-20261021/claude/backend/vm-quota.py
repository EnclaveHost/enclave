import subprocess,json
# READ-ONLY. Numbers only for the sia-s3 account: no public keys, app keys, user secrets, object/slab content.
A="(SELECT id FROM accounts WHERE name='sia-s3' AND deleted_at IS NULL)"
CK=f"(SELECT connect_key_id FROM accounts WHERE id IN {A})"
TIP="(SELECT max(settings_tip_height) FROM hosts)"
GOODH=f"(SELECT DISTINCT host_id FROM contracts WHERE good AND expiration_height > {TIP})"
Q={
 'db_now':"SELECT now()",
 'sia_s3_accounts':f"SELECT count(*) FROM accounts WHERE id IN {A}",
 'accounts_total_live':"SELECT count(*) FROM accounts WHERE deleted_at IS NULL",
 'quota':f"SELECT q.name||' max_pinned_data='||q.max_pinned_data||' fund_target_bytes='||q.fund_target_bytes FROM quotas q JOIN app_connect_keys ack ON ack.quota_name=q.name WHERE ack.id IN {CK}",
 'connect_key_pinned_data_size':f"SELECT ack.pinned_data||' / '||ack.pinned_size FROM app_connect_keys ack WHERE ack.id IN {CK}",
 'connect_key_accounts':f"SELECT count(*) FROM accounts WHERE connect_key_id IN {CK} AND deleted_at IS NULL",
 'account_pinned_data_max':f"SELECT a.pinned_data||' / max '||a.max_pinned_data FROM accounts a WHERE a.id IN {A}",
 'FULL_STORAGE_flag':f"SELECT (a.pinned_data >= a.max_pinned_data) OR (ack.pinned_data >= q.max_pinned_data) FROM accounts a JOIN app_connect_keys ack ON ack.id=a.connect_key_id JOIN quotas q ON q.name=ack.quota_name WHERE a.id IN {A}",
 'headroom_bytes':f"SELECT q.max_pinned_data - ack.pinned_data FROM accounts a JOIN app_connect_keys ack ON ack.id=a.connect_key_id JOIN quotas q ON q.name=ack.quota_name WHERE a.id IN {A}",
 'account_last_used':f"SELECT last_used FROM accounts WHERE id IN {A}",
 'account_hosts_by_failed_funds':f"SELECT coalesce(string_agg(f||'='||n,' ' ORDER BY f),'none') FROM (SELECT consecutive_failed_funds f,count(*) n FROM account_hosts WHERE account_id IN {A} GROUP BY 1) x",
 'account_hosts_good_hosts_failed_gt0':f"SELECT count(*) FROM account_hosts WHERE account_id IN {A} AND host_id IN {GOODH} AND consecutive_failed_funds>0",
 'account_hosts_next_fund_min_max':f"SELECT min(next_fund)||' .. '||max(next_fund) FROM account_hosts WHERE account_id IN {A}",
 'pool_exists':f"SELECT count(*) FROM pools WHERE connect_key_id IN {CK}",
 'pool_hosts_by_failed_funds':f"SELECT coalesce(string_agg(f||'='||n,' ' ORDER BY f),'none') FROM (SELECT consecutive_failed_funds f,count(*) n FROM pool_hosts WHERE pool_id IN (SELECT id FROM pools WHERE connect_key_id IN {CK}) GROUP BY 1) x",
 'pool_hosts_next_fund_min_max':f"SELECT min(next_fund)||' .. '||max(next_fund) FROM pool_hosts WHERE pool_id IN (SELECT id FROM pools WHERE connect_key_id IN {CK})",
 'pool_attachments_for_account':f"SELECT count(*) FROM pool_attachments WHERE account_id IN {A}",
 'good_hosts_pool_capable_v510plus':f"SELECT count(*) FROM hosts WHERE id IN {GOODH} AND ((get_byte(settings_protocol_version,0)<<16)+(get_byte(settings_protocol_version,1)<<8)+get_byte(settings_protocol_version,2)) >= ((5<<16)+(1<<8))",
 'good_hosts_protocol_versions':f"SELECT string_agg(v||'='||n,' ' ORDER BY v) FROM (SELECT get_byte(settings_protocol_version,0)||'.'||get_byte(settings_protocol_version,1)||'.'||get_byte(settings_protocol_version,2) v,count(*) n FROM hosts WHERE id IN {GOODH} GROUP BY 1) x",
}
out={}
for k,q in Q.items():
    p=subprocess.run(['docker','exec','enclave-indexd-postgres','psql','-U','postgres','-d','indexd','-Atq','-c',q],text=True,capture_output=True)
    out[k]=(p.stdout.strip() or p.stderr.strip()[:200])
print(json.dumps(out,indent=1))
