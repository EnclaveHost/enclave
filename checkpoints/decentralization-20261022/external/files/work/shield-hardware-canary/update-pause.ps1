# Retired: distinct canary Notes markers make pausing the production updater unnecessary.
param([string]$CanaryDir, [switch]$Apply, [switch]$Revert)
throw 'Production Update must remain unchanged. Use the separate canary VM name and Notes namespace.'
