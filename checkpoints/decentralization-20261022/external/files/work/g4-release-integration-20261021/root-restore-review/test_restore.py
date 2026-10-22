import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
PWSH = ROOT.parents[1] / 'node-hold-package-20261021/tools/pwsh/pwsh'
SOURCE = ROOT / 'install-host.r3.ps1'

PRELUDE = r'''
$ErrorActionPreference = 'Stop'
$script:PriorTasks = @{ Relay = @{ enabled = $true }; Checker = @{ enabled = $true } }
$script:StoppedOthers = @('Relay','Checker')
$script:OthersRestored = $false
$script:RestoredOthers = @{}
$script:Attempts = @{ Relay = 0; Checker = 0 }
$script:Reports = [Collections.Generic.List[object]]::new()
$script:Tasks = @{
 Relay = @{ State = 'Ready'; Settings = @{ Enabled = $true } }
 Checker = @{ State = 'Ready'; Settings = @{ Enabled = $true } }
}
function Emit($step,$state,$message) { $script:Reports.Add(@{ state=$state; message=$message }) }
function Get-ScheduledTask { param($TaskPath,$TaskName,$ErrorAction) return $script:Tasks[$TaskName] }
function Start-ScheduledTask { param($TaskPath,$TaskName,$ErrorAction)
 $script:Attempts[$TaskName]++
 if ($TaskName -eq 'Checker' -and $script:Attempts[$TaskName] -le $script:Failures) { throw 'scheduler denied request' }
 $script:Tasks[$TaskName].State = 'Running'
}
'''


def run_case(setup, source=SOURCE):
    text = source.read_text()
    start = text.index('function Restore-OtherTasks($why) {')
    end = text.index('# a core task', start)
    code = PRELUDE + text[start:end] + '\n' + setup + r'''
Restore-OtherTasks 'first attempt'
$firstDone = $script:OthersRestored
Restore-OtherTasks 'cleanup retry'
@{ attempts=$script:Attempts; firstDone=$firstDone; done=$script:OthersRestored;
 reports=@($script:Reports.ToArray()); restored=$script:RestoredOthers } | ConvertTo-Json -Depth 8 -Compress
'''
    with tempfile.TemporaryDirectory(prefix='installer-restore-') as tmp:
        script = Path(tmp) / 'test.ps1'
        script.write_text(code)
        result = subprocess.run([str(PWSH), '-NoProfile', '-NonInteractive', '-File', str(script)], capture_output=True, text=True, timeout=20)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return json.loads(result.stdout)


class RestoreTests(unittest.TestCase):
    def test_full_script_parses(self):
        result = subprocess.run([str(PWSH), '-NoProfile', '-NonInteractive', '-Command',
            "$e=$null;$t=$null;[void][Management.Automation.Language.Parser]::ParseFile('" + str(SOURCE) + "',[ref]$t,[ref]$e);if($e.Count){$e|ConvertTo-Json;exit 1}"], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_transient_failure_retries_only_failed_role(self):
        result = run_case('$script:Failures=1')
        self.assertFalse(result['firstDone'])
        self.assertTrue(result['done'])
        self.assertEqual(result['attempts'], {'Relay': 1, 'Checker': 2})
        self.assertEqual([r['state'] for r in result['reports']], ['warn', 'ok'])

    def test_persistent_failure_is_not_reported_restored(self):
        result = run_case('$script:Failures=100')
        self.assertFalse(result['done'])
        self.assertEqual(result['attempts'], {'Relay': 1, 'Checker': 2})
        self.assertNotIn('Checker', result['restored'])
        self.assertTrue(all(r['state'] == 'warn' for r in result['reports']))

    def test_current_operator_disable_is_preserved(self):
        result = run_case('$script:Failures=0; $script:Tasks.Checker.Settings.Enabled=$false')
        self.assertEqual(result['attempts']['Checker'], 0)
        self.assertTrue(result['done'])
        self.assertEqual(result['restored']['Checker'], 'operator-disabled')

    def test_original_disable_is_preserved(self):
        result = run_case('$script:Failures=0; $script:PriorTasks.Checker.enabled=$false')
        self.assertEqual(result['attempts']['Checker'], 0)
        self.assertTrue(result['done'])

    def test_removed_task_remains_pending(self):
        result = run_case('$script:Failures=0; $script:Tasks.Remove("Checker")')
        self.assertEqual(result['attempts']['Checker'], 0)
        self.assertFalse(result['done'])
        self.assertTrue(all(r['state'] == 'warn' for r in result['reports']))

    def test_running_role_is_not_started_twice(self):
        result = run_case('$script:Failures=0; $script:Tasks.Checker.State="Running"')
        self.assertEqual(result['attempts']['Checker'], 0)
        self.assertTrue(result['done'])

    def test_old_revision_exhibits_the_reported_retry_bug(self):
        old = ROOT.parent / 'revision2/installer/install-host.r2.ps1'
        result = run_case('$script:Failures=1', old)
        self.assertTrue(result['firstDone'])
        self.assertEqual(result['attempts']['Checker'], 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
