import subprocess,json
Q={
 'accounts':"SELECT string_agg(coalesce(name,'?')||' pinned_data='||pinned_data||' max_pinned_data='||max_pinned_data||' pinned_size='||pinned_size||' headroom='||(max_pinned_data-pinned_data)||' last_used='||coalesce(to_char(last_used,'HH24:MI:SS'),'-'), E'\\n' ORDER BY pinned_data DESC) FROM accounts WHERE deleted_at IS NULL",
 'objects_last_updated':"SELECT max(updated_at) FROM objects",
 'objects_by_account':"SELECT string_agg(account_id||'='||n, ' ') FROM (SELECT account_id,count(*) n FROM objects GROUP BY 1) x",
}
out={}
for k,q in Q.items():
    p=subprocess.run(['docker','exec','enclave-indexd-postgres','psql','-U','postgres','-d','indexd','-Atq','-c',q],text=True,capture_output=True)
    out[k]=(p.stdout.strip() or p.stderr.strip()[:200])
print(json.dumps(out,indent=1))
