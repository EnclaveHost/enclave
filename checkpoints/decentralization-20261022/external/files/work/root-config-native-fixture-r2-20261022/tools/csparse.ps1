# csparse.ps1 FILE... -- LOCAL syntax-only parse with Roslyn (from this pwsh), language version C# 5 (csc v4.0.30319's level).
# Not a build: no reference/semantic check. Prints error diagnostics; exit 1 if any.
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSHOME 'Microsoft.CodeAnalysis.dll'); Add-Type -Path (Join-Path $PSHOME 'Microsoft.CodeAnalysis.CSharp.dll')
$opt = [Microsoft.CodeAnalysis.CSharp.CSharpParseOptions]::Default.WithLanguageVersion([Microsoft.CodeAnalysis.CSharp.LanguageVersion]::CSharp5)
$bad = 0
foreach ($f in $args) {
  $tree = [Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree]::ParseText([IO.File]::ReadAllText($f), $opt)
  # syntax errors, plus the C# language-version FEATURE errors (CS8026-style "is not available in C# 5") of a reference-free
  # compilation; its other errors (no mscorlib reference, no Main) are expected noise and ignored. Not a build.
  $comp = [Microsoft.CodeAnalysis.CSharp.CSharpCompilation]::Create("parse-only", [Microsoft.CodeAnalysis.SyntaxTree[]]@($tree))
  $errs = @(@($tree.GetDiagnostics() | Where-Object { $_.Severity -eq 'Error' }) +
            @($comp.GetDiagnostics() | Where-Object { $_.Severity -eq 'Error' -and $_.GetMessage() -match 'is not available in C# 5' }) | Sort-Object { $_.ToString() } -Unique)
  "{0}: {1} error(s)" -f [IO.Path]::GetFileName($f), $errs.Count
  $errs | ForEach-Object { "  " + $_.ToString() }; $bad += $errs.Count
}
if ($bad) { exit 1 }
