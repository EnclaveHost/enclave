$a=New-Object Security.AccessControl.DirectorySecurity; $a.SetAccessRuleProtection($true,$false)
$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier("S-1-5-18")),"FullControl","ContainerInherit,ObjectInherit","None","Allow"))); "dirsec ok"
