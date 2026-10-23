"""Targeted mutants of 24fb993c, each run against test/host-service-lifecycle.test.mjs in the scratch worktree mut/ (restored
from Git after every mutant). A mutant is KILLED when the suite fails (by assertion, inside its bounded time)."""
import subprocess, sys, pathlib, os
H = pathlib.Path(__file__).resolve().parent; M = H / 'mut'
MUTANTS = {
 'M1-insert-after-close (transport keeps a late circuit)': ('network/host-service-transport.mjs', "if (this.closed) { await this.retire(c, 'stopped during startup'); return; }", ''),
 'M2-no-withdraw-on-failed-start (runtime)': ('network/wg-circuit-runtime.mjs', 'if(service&&exitAsked&&!exitRefused){', 'if(false){'),
 'M3-no-abort-listener (runtime ignores the stop while waiting)': ('network/wg-circuit-runtime.mjs', "signal?.addEventListener('abort',onAbort,{once:true});", ''),
 'M4-timer-after-close (transport start)': ('network/host-service-transport.mjs', '    if (this.closed) return this;\n', ''),
 'M5-judge-awaits-startup (lifecycle)': ('network/host-service-transport.mjs', 'void h.start().then(', 'await h.start().then('),
 'M6-close-waits-before-withdrawing-live (transport)': ('network/host-service-transport.mjs',
   "      for (const id of [...this.circuits.keys()]) await this.drop(id, 'stopped');\n      const run = this.running;",
   "      await this.running?.catch(() => {});\n      const run = this.running;"),
}
results = {}
for name, (f, old, new) in MUTANTS.items():
    subprocess.run(['git', '-C', str(M), 'checkout', '-q', '--', '.'], check=True)
    p = M / f; s = p.read_text(); assert s.count(old) == 1, (name, s.count(old)); p.write_text(s.replace(old, new))
    r = subprocess.run([str(H / 'job.sh'), 'test/host-service-lifecycle.test.mjs'], env={**os.environ, 'TREE': str(M), 'JOB_SEC': '150', 'TEST_TIMEOUT_MS': '60000'},
                       capture_output=True, text=True)
    fails = [l for l in r.stdout.splitlines() if l.startswith('✖') and 'host-service-lifecycle.test.mjs' not in l][:9]
    counts = [l for l in r.stdout.splitlines() if l.startswith('ℹ ') and l.split()[1] in ('pass', 'fail', 'cancelled')]
    print('   ', ' '.join(counts))
    results[name] = 'KILLED' if r.returncode != 0 else 'SURVIVED'
    print(f'{results[name]:8} {name}  (exit {r.returncode})'); [print('   ', l[:150]) for l in dict.fromkeys(fails)]
subprocess.run(['git', '-C', str(M), 'checkout', '-q', '--', '.'], check=True)
print('MUTANTS', sum(v == 'KILLED' for v in results.values()), '/', len(results), 'killed')
sys.exit(0 if all(v == 'KILLED' for v in results.values()) else 1)
