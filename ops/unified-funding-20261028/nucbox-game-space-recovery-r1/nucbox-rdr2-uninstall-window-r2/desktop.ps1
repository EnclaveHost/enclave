$ErrorActionPreference='Stop';$root='C:\ProgramData\CodexGameCleanup-4c8714fbcfb849baace662cc5f237838'
try {
 Add-Type -AssemblyName UIAutomationClient;Add-Type -AssemblyName UIAutomationTypes;Add-Type -AssemblyName System.Drawing
 $e=[Windows.Automation.AutomationElement]::FromHandle([IntPtr]196888);$c=$e.Current
 if($c.Name -ne 'Uninstall' -or $c.ProcessId -ne 24392 -or $c.IsOffscreen){throw 'Exact uninstall dialog unavailable'}
 $b=$c.BoundingRectangle;if($b.Width -gt 1600 -or $b.Height -gt 1200 -or $b.Width -lt 100 -or $b.Height -lt 100){throw 'Dialog bounds'}
 $bmp=New-Object Drawing.Bitmap([int]$b.Width,[int]$b.Height);$g=[Drawing.Graphics]::FromImage($bmp)
 Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class GameWindow{[DllImport("user32.dll")]public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);}'
 [GameWindow]::SetForegroundWindow([IntPtr]196888)|Out-Null;Start-Sleep -Milliseconds 500
 $dc=$g.GetHdc();try{$printed=[GameWindow]::PrintWindow([IntPtr]196888,$dc,2)}finally{$g.ReleaseHdc($dc)}
 if(-not $printed){throw 'PrintWindow failed'};$m=New-Object IO.MemoryStream;$bmp.Save($m,[Drawing.Imaging.ImageFormat]::Png);$g.Dispose();$bmp.Dispose()
 $bytes=$m.ToArray();$m.Dispose();if($bytes.Length -gt 150000){throw 'Image output bound'}
 [ordered]@{success=$true;title=$c.Name;pid=$c.ProcessId;handle=196888;x=$b.X;y=$b.Y;width=$b.Width;height=$b.Height;png=[Convert]::ToBase64String($bytes)}|ConvertTo-Json -Compress|Set-Content -LiteralPath ($root+'\result.json') -Encoding UTF8
}catch{[ordered]@{success=$false;error=$_.Exception.Message}|ConvertTo-Json -Compress|Set-Content -LiteralPath ($root+'\result.json') -Encoding UTF8}
