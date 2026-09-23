# Run one command so it OUTLIVES this ssh session (Win32_Process.Create is serviced by WMI, outside the
# session's job), with its output in a log file. Usage: rbdetach.ps1 "<command line>" <logfile>
param([string]$Cmd, [string]$Log)
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = "cmd.exe /c $Cmd >> `"$Log`" 2>&1"
  CurrentDirectory = 'C:\Users\claude\vbs\node'
}
"Win32_Process.Create -> rc=$($r.ReturnValue) pid=$($r.ProcessId)"
