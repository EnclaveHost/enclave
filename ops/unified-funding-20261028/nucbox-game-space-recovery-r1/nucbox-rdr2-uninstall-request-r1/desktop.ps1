$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$root='C:\ProgramData\CodexGameCleanup-4dddf5cd0e0a476ea983f34f33e70508'
try {
 $s=Get-CimInstance Win32_Process -Filter 'ProcessId=45672'
 if($s.ExecutablePath -ne 'C:\Program Files (x86)\Steam\steam.exe' -or $s.CreationDate.ToUniversalTime().ToString('o') -ne '2026-10-27T22:20:46.3038980Z' -or [Diagnostics.Process]::GetCurrentProcess().SessionId -ne 1){throw 'Steam/session identity changed'}
 $reg=Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Steam App 1174180'
 if($reg.DisplayName -ne 'Red Dead Redemption 2' -or $reg.InstallLocation -ne 'C:\Program Files (x86)\Steam\steamapps\common\Red Dead Redemption 2'){throw 'Game uninstall identity changed'}
 [IO.File]::WriteAllText(($root+'\intent.json'),('{"game":"Red Dead Redemption 2","appId":1174180,"requestOnce":true}'))
 Start-Process -FilePath 'C:\Program Files (x86)\Steam\steam.exe' -ArgumentList 'steam://uninstall/1174180'
 Start-Sleep -Seconds 3
 Add-Type -AssemblyName UIAutomationClient
 Add-Type -AssemblyName UIAutomationTypes
 $ids=@(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -like 'C:\Program Files (x86)\Steam\*'}|Select-Object -ExpandProperty ProcessId)
 $wins=[Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)
 $out=@()
 foreach($w in $wins){$wc=$w.Current;if($ids -notcontains $wc.ProcessId){continue};$items=@();$all=$w.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition);$count=[Math]::Min(256,$all.Count)
  for($i=0;$i -lt $count;$i++){$c=$all[$i].Current;$items+=[ordered]@{name=$c.Name;id=$c.AutomationId;type=$c.ControlType.ProgrammaticName;enabled=$c.IsEnabled;offscreen=$c.IsOffscreen}}
  $out+=[ordered]@{title=$wc.Name;pid=$wc.ProcessId;handle=$wc.NativeWindowHandle;children=$items}
 }
 [ordered]@{success=$true;phase='requested-once';windows=$out;identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name;session=[Diagnostics.Process]::GetCurrentProcess().SessionId}|ConvertTo-Json -Depth 8 -Compress|Set-Content -LiteralPath ($root+'\result.json') -Encoding UTF8
}catch{[ordered]@{success=$false;error=$_.Exception.Message;line=$_.InvocationInfo.ScriptLineNumber}|ConvertTo-Json -Compress|Set-Content -LiteralPath ($root+'\result.json') -Encoding UTF8}
