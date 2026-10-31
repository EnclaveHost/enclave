$ErrorActionPreference='Stop';$root='C:\ProgramData\CodexGameCleanup-28a500e254fc488a8c0909b1d9d01ead'
try {
 Add-Type -AssemblyName UIAutomationClient;Add-Type -AssemblyName UIAutomationTypes;Add-Type -AssemblyName System.Drawing
 Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class GameConfirm{[DllImport("user32.dll")]public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);}'
 $e=[Windows.Automation.AutomationElement]::FromHandle([IntPtr]196888);$c=$e.Current;$b=$c.BoundingRectangle
 if($c.Name -ne 'Uninstall' -or $c.ProcessId -ne 24392 -or $c.IsOffscreen -or $b.X -ne 0 -or $b.Y -ne 208 -or $b.Width -ne 640 -or $b.Height -ne 224){throw 'Exact reviewed dialog changed'}
 [GameConfirm]::SetForegroundWindow([IntPtr]196888)|Out-Null;Start-Sleep -Milliseconds 300
 $bmp=New-Object Drawing.Bitmap(640,224);$g=[Drawing.Graphics]::FromImage($bmp);$dc=$g.GetHdc();try{$ok=[GameConfirm]::PrintWindow([IntPtr]196888,$dc,2)}finally{$g.ReleaseHdc($dc)}
 if(-not $ok){throw 'Print failed'};$m=New-Object IO.MemoryStream;$bmp.Save($m,[Drawing.Imaging.ImageFormat]::Png);$g.Dispose();$bmp.Dispose();$hash=([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($m.ToArray()))).Replace('-','').ToLowerInvariant();$m.Dispose()
 if($hash -ne '53430ce9ef231157a0acbf94dccfdf6af2733f4eaa82603b430e3682e7665b11'){throw 'Reviewed dialog pixel digest differs'}
 if([GameConfirm]::GetForegroundWindow().ToInt64() -ne 196888){throw 'Foreground differs'}
 [IO.File]::WriteAllText(($root+'\confirm.intent'),('app1174180;reviewed-dialog-sha256='+$hash+';one-click;'+[DateTime]::UtcNow.ToString('o')))
 if(-not [GameConfirm]::SetCursorPos(167,390)){throw 'Cursor failed'}
 [GameConfirm]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[GameConfirm]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
 Start-Sleep -Seconds 6
 $disk=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
 [ordered]@{success=$true;confirmedOnce=$true;appId=1174180;dialogSha256=$hash;atUtc=[DateTime]::UtcNow.ToString('o');diskFreeBytes=[int64]$disk.FreeSpace;manifestExists=(Test-Path -LiteralPath 'C:\Program Files (x86)\Steam\steamapps\appmanifest_1174180.acf');gameDirectoryExists=(Test-Path -LiteralPath 'C:\Program Files (x86)\Steam\steamapps\common\Red Dead Redemption 2');uninstallEntryExists=(Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Steam App 1174180')}|ConvertTo-Json -Compress|Set-Content -LiteralPath ($root+'\result.json') -Encoding UTF8
}catch{[ordered]@{success=$false;error=$_.Exception.Message;line=$_.InvocationInfo.ScriptLineNumber;confirmIntentExists=(Test-Path -LiteralPath ($root+'\confirm.intent'))}|ConvertTo-Json -Compress|Set-Content -LiteralPath ($root+'\result.json') -Encoding UTF8}
