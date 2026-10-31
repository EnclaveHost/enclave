$ErrorActionPreference='Stop'
try {
 $steam=Get-CimInstance Win32_Process -Filter "ProcessId=45672"
 if($steam.Name -ne 'steam.exe' -or $steam.ExecutablePath -ne 'C:\Program Files (x86)\Steam\steam.exe'){throw 'Steam identity changed'}
 $owner=Invoke-CimMethod -InputObject $steam -MethodName GetOwner
 $games=@(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -like 'C:\Program Files (x86)\Steam\steamapps\common\*'}|Select-Object ProcessId,CreationDate,ExecutablePath)
 $p=Get-Process -Id 45672
 [ordered]@{success=$true;steam=[ordered]@{pid=45672;created=$steam.CreationDate.ToUniversalTime().ToString('o');sessionId=$steam.SessionId;owner=$owner.User;domain=$owner.Domain;ownerResult=$owner.ReturnValue;title=$p.MainWindowTitle;handle=$p.MainWindowHandle.ToInt64()};gameProcesses=$games;currentIdentity=[Security.Principal.WindowsIdentity]::GetCurrent().Name;currentSession=[Diagnostics.Process]::GetCurrentProcess().SessionId}|ConvertTo-Json -Depth 6 -Compress
}catch{[ordered]@{success=$false;error=$_.Exception.Message;line=$_.InvocationInfo.ScriptLineNumber}|ConvertTo-Json -Compress}
