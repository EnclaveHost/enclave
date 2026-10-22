# PARSE (never run) each probe step with PowerShell's parser and list what it could do: every command name, every .NET
# member invoked, every file redirection, every assignment target. The Python test judges the lists against an allowlist.
param([string]$StepsJson)
$S = Get-Content -Raw -LiteralPath $StepsJson | ConvertFrom-Json
$out = [ordered]@{}
foreach ($p in $S.PSObject.Properties) {
  $errs = $null; $ast = [System.Management.Automation.Language.Parser]::ParseInput([string]$p.Value, [ref]$null, [ref]$errs)
  $cmds = @($ast.FindAll({ $args[0] -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object {
    $n = $_.GetCommandName(); if ($n) { $n } else { 'EXPR:' + $_.CommandElements[0].Extent.Text + ' ' + (@($_.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.Extent.Text }) -join ' ') } })
  $members = @($ast.FindAll({ $args[0] -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true) | ForEach-Object { $_.Member.Extent.Text })
  $redir = @($ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FileRedirectionAst] }, $true) | ForEach-Object { $_.Extent.Text })
  $assign = @($ast.FindAll({ $args[0] -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true) | ForEach-Object { $_.Left.Extent.Text })
  $out[$p.Name] = [ordered]@{ errors = @($errs | ForEach-Object { $_.Message }); commands = @($cmds | Sort-Object -Unique); members = @($members | Sort-Object -Unique)
                              redirections = $redir; assignments = @($assign | Sort-Object -Unique) }
}
$out | ConvertTo-Json -Depth 5 -Compress
