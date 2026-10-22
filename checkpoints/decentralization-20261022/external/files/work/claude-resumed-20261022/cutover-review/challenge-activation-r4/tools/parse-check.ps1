param([string]$F)
foreach ($f in $F.Split(',')) { $tk=$null;$er=$null; [void][Management.Automation.Language.Parser]::ParseFile($f,[ref]$tk,[ref]$er); "$f errors=$($er.Count) $($er | Select-Object -First 3 | ForEach-Object { $_.Message + ' @' + $_.Extent.StartLineNumber })" }
