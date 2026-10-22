#!/usr/bin/env python3
"""Per-cron respawn correction (+ the host-admission bundle swap) on minipc. ONLY ROOT RUNS IT; root makes the go/no-go.
Every mutating step needs --execute AND --root-authorized AND pins from a fresh `preflight` receipt. Each step writes
receipt-<step>-<UTC>.json here (script shas, activate.py's sha, the sha256 of every exact PowerShell command sent);
stdout is public data only (ids, numbers, hashes, PIDs, booleans, redacted log lines).

Scripts are executed from HASH-VERIFIED BYTES: the staged file is read, its sha256 must equal this file's pin of the
local bytes, and exactly those bytes run as a ScriptBlock. No -File, no execution-policy change of any scope.

  preflight        READ-ONLY: staged script pins; pinned live code; respawn inspect (Delay keep + the refused 600000
                   variant); node identify (PIDs + creation times of the agent, run-node cmd, manager, every other task's
                   processes); restart gates (short leases, wallet-policy flaps)
  write-config     CAS: append the cron id to ENCLAVE_ISOLATION_RESPAWN_IDS (Delay keep)      --expect-config --expect-local
  bundle-inspect   READ-ONLY view of a bundle swap                                            --new-sha [--new-file]
  bundle-apply     CAS: host-admission.bundle.mjs 7ce23a55… -> the staged root-pinned bytes   --new-sha [--new-file]
  restart-node     node agent ONLY (task \\Enclave\\Node), ONE coordinated restart for both changes:
                   --expect-agent-pid/-start --expect-cmd-pid/-start --expect-manager-pid/-start [--expect-bundle-sha]
                   gates: no running lease < 10 min, no wallet-policy flap in 10 min. --coordinated-repair (ROOT-OWNED)
                   skips ONLY those two gates when the repair is the fix for that very failure: it needs
                   --repair-reason, records the gate evidence, and keeps every pin, the pause bound and the verification
  verify           READ-ONLY: respawn inspect == noop, identify, node lines since the restart
  rollback-config  CAS: --expect-local <current> --expect-backup <pre-apply sha | none>
  bundle-rollback  CAS: --expect-current <current> (backup must be 7ce23a55…)
Pinned live code (refuses on any difference): host.mjs 2500c650…, agent.mjs c223c043…, wmiserve-run.mjs 8107f272…,
server.mjs 58b5d7fd…, run-node.cmd 3366a005…, host-admission.bundle.mjs 7ce23a55… (or --expect-bundle-sha after a swap)."""
import argparse, hashlib, json, os, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, '..', 'probe.py')).read().split("LOGS = r")[0]
ns = {}; exec(compile(src, 'probe.py', 'exec'), ns); ps = ns['ps']; redact = ns['redact']
STAGE = r"C:\ProgramData\Enclave\hotfix\cron-respawn-20261021"; LIVE = r"C:\ProgramData\Enclave"
CRON = '0x38f368d67995676e0bbe48ebbc1d18a643bb314942374b44e1e52239a1cd215c'
BUNDLE_OLD = '7ce23a55c9ffccf1c30c818ef3d7a6774cf3c8743fcac62a1421d11456794fc6'
BUNDLE_NEW_FILE = STAGE + r"\bundle\host-admission.bundle.mjs"          # root stages the approved public file here
CODE = {r'node\host.mjs': '2500c650d56c2cb526530c68b2469dde3eeb5044728a1e5f81888142e21f181c',
        r'node\agent.mjs': 'c223c0435d859f0bde0d496a2eb1e8a2db4af44a47e32bf653710244c5ccd2ba',
        r'vbslike\manager\wmiserve-run.mjs': '8107f272741c40a3d6ea51c0054d5fdc0904cd277346265cd01ca9de1c74ed17',
        r'vbslike\manager\server.mjs': '58b5d7fd76e7d3bbd3c64780a27e8475dce4dd1aa21753f1e44aaee9c5ea8beb'}
BUNDLE_KEY = r'node\host-admission.bundle.mjs'
RUN_NODE = '3366a005f8530903c83a334053280f41ed904df09133e92505c44f558acb6686'
sha = lambda b: hashlib.sha256(b).hexdigest()
NAMES = ('cron-respawn.ps1', 'node-restart.ps1', 'bundle-swap.ps1')
SCRIPTS = {f: sha(open(os.path.join(HERE, f), 'rb').read()) for f in NAMES}
q = lambda v: "'" + str(v).replace("'", "''") + "'"

def remote(cmd, secs=150):
    return {'commandSha256': sha(cmd.encode()), 'result': ps(cmd, secs)}
def run_script(name, params, secs=150, stage=STAGE):
    """the staged script, executed ONLY if its bytes are this file's pin; those exact bytes run (ScriptBlock)"""
    splat = '@{' + ';'.join(f"{k}={v if isinstance(v, int) else q(v)}" for k, v in params.items()) + '}'
    cmd = (f"$p={q(stage + chr(92) + name)};$b=[IO.File]::ReadAllBytes($p);$h=([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($b)) -replace '-','').ToLower();"
           f"if($h -ne '{SCRIPTS[name]}'){{'{{\"decision\":\"refused: the staged {name} is not the pinned bytes\"}}';exit 0}};"
           f"$a={splat};& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($b))) @a")
    return remote(cmd, secs)
def receipt(step, body):
    p = os.path.join(HERE, f"receipt-{step}-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}.json")
    body = {'step': step, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'scripts': SCRIPTS, 'activateSha256': sha(open(__file__, 'rb').read()), **body}
    with open(p, 'x') as f: json.dump(body, f, indent=1)
    print(json.dumps(body, indent=1)); return body
def pins_ok(bundle_sha=BUNDLE_OLD):
    want = {**CODE, BUNDLE_KEY: bundle_sha}
    r = remote("$o=[ordered]@{};foreach($f in @(%s)){$p=Join-Path %s $f;$o[$f]=$(if(Test-Path -LiteralPath $p){(Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower()}else{'absent'})};"
               "$m='C:\\Program Files\\Enclave\\control\\windows';foreach($f in @(%s)){$o[$f]=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $m $f)).Hash.ToLower()};$o|ConvertTo-Json -Compress"
               % (','.join(q(n) for n in NAMES), q(STAGE), ','.join(q(k) for k in want)), 90)
    got = r['result'] if isinstance(r['result'], dict) else {}
    return r, [f for f in NAMES if got.get(f) != SCRIPTS[f]] + [k for k in want if got.get(k) != want[k]]
def restart_gates():
    """READ-ONLY: running leases with < 10 min left; 'host wallet policy unavailable' lines in node.log's last 10 minutes"""
    return remote("$d=Invoke-RestMethod -UseBasicParsing -TimeoutSec 20 -Uri 'http://127.0.0.1:9600/v1/deployments';$all=@($d.deployments);if(-not $all){$all=@($d)};"
                  "$now=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds();$short=@($all|Where-Object{$_.status -eq 'running' -and $_.leaseUntil -and ([int64]$_.leaseUntil - $now) -lt 600}).Count;"
                  "$t=(Get-Date).ToUniversalTime().AddMinutes(-10).ToString('HH:mm');"
                  "$f=@(Get-Content -LiteralPath 'C:\\ProgramData\\Enclave\\logs\\node.log' -Tail 2000|Select-String -SimpleMatch 'host wallet policy unavailable'|ForEach-Object{$_.Line.Substring(0,5)}|Where-Object{$_ -ge $t}).Count;"
                  "[ordered]@{shortLeases=$short;policyUnavailableLast10min=$f}|ConvertTo-Json -Compress", 90)
inspect = lambda delay='keep': run_script('cron-respawn.ps1', {'Mode': 'inspect', 'Dir': LIVE, 'Id': CRON, 'Delay': delay}, 90)
identify = lambda: run_script('node-restart.ps1', {'Mode': 'identify'}, 150)

def main(argv):
    a = argparse.ArgumentParser()
    a.add_argument('step', choices=['preflight', 'write-config', 'bundle-inspect', 'bundle-apply', 'restart-node', 'verify', 'rollback-config', 'bundle-rollback'])
    for k in ('expect-config', 'expect-local', 'expect-backup', 'expect-current', 'expect-agent-start', 'expect-cmd-start', 'expect-manager-start',
              'new-sha', 'restarted-at', 'repair-reason'): a.add_argument('--' + k, default='')
    for k in ('expect-agent-pid', 'expect-cmd-pid', 'expect-manager-pid'): a.add_argument('--' + k, type=int, default=0)
    a.add_argument('--new-file', default=BUNDLE_NEW_FILE); a.add_argument('--expect-bundle-sha', default=BUNDLE_OLD)
    a.add_argument('--max-pause-sec', type=int, default=120)
    for k in ('execute', 'root-authorized', 'coordinated-repair'): a.add_argument('--' + k, action='store_true')
    o = a.parse_args(argv)
    st, bad = pins_ok(o.expect_bundle_sha)
    if o.step == 'preflight':
        return receipt('preflight', {'pins': st, 'pinMismatches': bad, 'inspectKeepDelay': inspect('keep'), 'inspectDelay600000': inspect('600000'),
                                     'identify': identify(), 'restartGates': restart_gates()})
    if o.step == 'verify':
        lines = remote("$l=@(Get-Content -LiteralPath 'C:\\ProgramData\\Enclave\\logs\\node.log' -Tail 3000 | Select-String -SimpleMatch -Pattern "
                       "@('isolated domain retired','giving up on','isolation adopted','isolation spawned','respawn','host wallet policy unavailable') | ForEach-Object {$_.Line});"
                       "ConvertTo-Json -InputObject @($l | Select-Object -Last 60) -Compress", 120)
        ls = [redact(x) for x in (lines['result'] if isinstance(lines['result'], list) else [])]
        keep = inspect('keep')
        return receipt('verify', {'pinMismatches': bad, 'identify': identify(), 'inspect': keep, 'nodeLines': ls,
            'counts': {k: sum(1 for x in ls if k in x) for k in ('isolated domain retired', 'giving up on', 'isolation adopted', 'isolation spawned', 'host wallet policy unavailable')},
            'pass': bad == [] and keep['result'].get('decision') == 'noop: already configured'})
    if o.step == 'bundle-inspect':
        return receipt('bundle-inspect', {'pinMismatches': bad, 'inspect': run_script('bundle-swap.ps1', {'Mode': 'inspect', 'WorkDir': STAGE, 'OldSha': BUNDLE_OLD, 'NewFile': o.new_file, 'NewSha': o.new_sha}, 120)})
    # mutating steps
    if not (o.execute and o.root_authorized): sys.exit('refused: a mutating step needs --execute --root-authorized (root only)')
    if bad: sys.exit(f'refused: pinned file mismatch {bad}')
    if o.step == 'write-config':
        if not (o.expect_config and o.expect_local): sys.exit('refused: --expect-config and --expect-local from a fresh preflight')
        r = run_script('cron-respawn.ps1', {'Mode': 'apply', 'Dir': LIVE, 'Id': CRON, 'Delay': 'keep', 'ExpectConfig': o.expect_config, 'ExpectLocal': o.expect_local}, 120)
        return receipt('write-config', {'apply': r, 'rollback': f"rollback-config --expect-local <apply.result.after> --expect-backup {o.expect_local if o.expect_local != 'absent' else 'none'}"})
    if o.step == 'rollback-config':
        if not (o.expect_local and o.expect_backup): sys.exit('refused: --expect-local (the CURRENT bytes) and --expect-backup')
        return receipt('rollback-config', {'rollback': run_script('cron-respawn.ps1', {'Mode': 'rollback', 'Dir': LIVE, 'ExpectLocal': o.expect_local, 'ExpectBackup': o.expect_backup}, 120)})
    if o.step == 'bundle-apply':
        if not o.new_sha: sys.exit('refused: --new-sha (root pins the new bundle bytes)')
        r = run_script('bundle-swap.ps1', {'Mode': 'apply', 'WorkDir': STAGE, 'OldSha': BUNDLE_OLD, 'NewFile': o.new_file, 'NewSha': o.new_sha}, 150)
        return receipt('bundle-apply', {'apply': r, 'next': f'restart-node ... --expect-bundle-sha {o.new_sha}; rollback: bundle-rollback --expect-current {o.new_sha}'})
    if o.step == 'bundle-rollback':
        if not o.expect_current: sys.exit('refused: --expect-current (the CURRENT target bytes)')
        return receipt('bundle-rollback', {'rollback': run_script('bundle-swap.ps1', {'Mode': 'rollback', 'WorkDir': STAGE, 'OldSha': BUNDLE_OLD, 'ExpectCurrent': o.expect_current}, 150)})
    if o.step == 'restart-node':
        need = [o.expect_agent_pid, o.expect_agent_start, o.expect_cmd_pid, o.expect_cmd_start, o.expect_manager_pid, o.expect_manager_start]
        if not all(need): sys.exit('refused: --expect-agent-pid/-start, --expect-cmd-pid/-start, --expect-manager-pid/-start from a fresh identify')
        g = restart_gates(); gr = g['result'] if isinstance(g['result'], dict) else {}
        gates_pass = gr.get('shortLeases') == 0 and gr.get('policyUnavailableLast10min') == 0
        if not gates_pass and not o.coordinated_repair:
            sys.exit(f'refused: restart gates {gr}. A root-owned --coordinated-repair --repair-reason "..." may proceed when this restart IS the fix for that failure')
        if o.coordinated_repair and not o.repair_reason.strip(): sys.exit('refused: --coordinated-repair needs --repair-reason')
        if not 30 <= o.max_pause_sec <= 180: sys.exit('refused: --max-pause-sec 30..180')
        r = run_script('node-restart.ps1', {'Mode': 'restart', 'ExpectRunNodeSha': RUN_NODE, 'ExpectAgentPid': o.expect_agent_pid, 'ExpectAgentStart': o.expect_agent_start,
                       'ExpectCmdPid': o.expect_cmd_pid, 'ExpectCmdStart': o.expect_cmd_start, 'ExpectManagerPid': o.expect_manager_pid,
                       'ExpectManagerStart': o.expect_manager_start, 'MaxPauseSec': o.max_pause_sec}, 330)
        return receipt('restart-node', {'gates': g, 'gatesPassed': gates_pass, 'coordinatedRepair': o.coordinated_repair, 'repairReason': o.repair_reason,
                                        'bundleSha': o.expect_bundle_sha, 'restart': r, 'next': 'verify --restarted-at <restart.result.startedAt HH:MM>'})

if __name__ == '__main__':
    main(sys.argv[1:])
