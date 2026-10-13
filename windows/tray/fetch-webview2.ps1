# fetch-webview2.ps1 -- the WebView2 SDK files the tray is built against and ships beside its exe, from the pinned NuGet
# package (checked against its sha256 before anything is taken from it):
#   Microsoft.Web.WebView2.Core.dll, Microsoft.Web.WebView2.WinForms.dll   (lib\net462)
#   WebView2Loader.dll                                                     (runtimes\win-x64\native)
#   WebView2-LICENSE.txt                                                   (the package's LICENSE.txt, BSD-3: ships with them)
# into -Dest (default: this folder). The browser itself is the Microsoft Edge WebView2 Runtime already on Windows 11 (and
# on Windows 10 with Edge); the tray says so and links to it where it is missing.
#   powershell -NoProfile -ExecutionPolicy Bypass -File fetch-webview2.ps1 [-Dest <dir>] [-Cache <dir>]
param(
  [string] $Dest = $PSScriptRoot,
  [string] $Cache = (Join-Path $env:LOCALAPPDATA "Enclave\build-cache")
)
$ErrorActionPreference = "Stop"
$Version = "1.0.4191.47"                                                    # published 2026-08-28
$Sha256  = "f492bbf547d0da329553b6727435b677579b1e9f91cc9e4a1ad029366d5f23d0"
$Url     = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$Version/microsoft.web.webview2.$Version.nupkg"
$Take = [ordered]@{
  "lib/net462/Microsoft.Web.WebView2.Core.dll"       = "Microsoft.Web.WebView2.Core.dll"
  "lib/net462/Microsoft.Web.WebView2.WinForms.dll"   = "Microsoft.Web.WebView2.WinForms.dll"
  "runtimes/win-x64/native/WebView2Loader.dll"       = "WebView2Loader.dll"
  "LICENSE.txt"                                      = "WebView2-LICENSE.txt"
}
New-Item -ItemType Directory -Force $Cache, $Dest | Out-Null
$pkg = Join-Path $Cache "microsoft.web.webview2.$Version.nupkg"
function Sha($p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() }
if (-not (Test-Path $pkg) -or (Sha $pkg) -ne $Sha256) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  "webview2: downloading $Version"
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile "$pkg.part"
  $got = Sha "$pkg.part"
  if ($got -ne $Sha256) { Remove-Item "$pkg.part" -Force; throw "fetch-webview2: the package hashes to $got, not the pinned $Sha256" }
  Move-Item -Force "$pkg.part" $pkg
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($pkg)
try {
  foreach ($k in $Take.Keys) {
    $e = $zip.GetEntry($k); if (-not $e) { throw "fetch-webview2: $k is not in the package" }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($e, (Join-Path $Dest $Take[$k]), $true)
  }
} finally { $zip.Dispose() }
"webview2: SDK $Version in $Dest"
