// Native .NET Framework / NTFS checks for the config migration's ACL primitives.
// Dummy bytes and fresh test paths only; does not load or modify host configuration.
using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
public static class PrivateFileCheck {
 static readonly SecurityIdentifier SystemSid = new SecurityIdentifier("S-1-5-18");
 static readonly SecurityIdentifier AdminSid = new SecurityIdentifier("S-1-5-32-544");
 static void Check(bool ok,string name) { Console.WriteLine((ok?"PASS ":"FAIL ")+name);if(!ok)throw new Exception(name); }
 static FileSecurity Security(bool systemReadOnly) {
  FileSecurity sec=new FileSecurity();sec.SetAccessRuleProtection(true,false);sec.SetOwner(AdminSid);
  sec.AddAccessRule(new FileSystemAccessRule(AdminSid,FileSystemRights.FullControl,AccessControlType.Allow));
  sec.AddAccessRule(new FileSystemAccessRule(SystemSid,systemReadOnly?FileSystemRights.Read:FileSystemRights.FullControl,AccessControlType.Allow));return sec;
 }
 static void WritePrivate(string path,byte[] bytes) {
  using(FileStream file=new FileStream(path,FileMode.CreateNew,FileSystemRights.FullControl,FileShare.None,4096,FileOptions.WriteThrough,Security(false))) {
   FileSecurity sec=file.GetAccessControl();
   Check(sec.AreAccessRulesProtected,"DACL protected before writing content");
   Check(sec.GetOwner(typeof(SecurityIdentifier)).Value==AdminSid.Value,"owner set at file creation");
   foreach(FileSystemAccessRule rule in sec.GetAccessRules(true,true,typeof(SecurityIdentifier)))
    if(rule.AccessControlType==AccessControlType.Allow)Check(rule.IdentityReference.Value==AdminSid.Value||rule.IdentityReference.Value==SystemSid.Value,"only SYSTEM/Administrators allowed at creation");
   file.Write(bytes,0,bytes.Length);file.Flush(true);
  }
 }
 static string Dacl(string p) { return File.GetAccessControl(p).GetSecurityDescriptorSddlForm(AccessControlSections.Access|AccessControlSections.Owner); }
 public static int Main(string[] args) {
  try {
   if(args.Length!=1)throw new Exception("one isolated stage required");
   string root=Path.GetFullPath(args[0]);
   if(!Regex.IsMatch(root,@"^C:\\ProgramData\\Enclave\\staging\\private-file-check-[0-9a-f]{12}$",RegexOptions.IgnoreCase)||!Directory.Exists(root))throw new Exception("wrong stage");
   string target=Path.Combine(root,"target.cmd"),temp=Path.Combine(root,"replacement.tmp"),backupDir=Path.Combine(root,"backup"),backup=Path.Combine(backupDir,"target.cmd");
   byte[] old=Encoding.ASCII.GetBytes("old dummy configuration\r\n"),fresh=Encoding.ASCII.GetBytes("new dummy configuration\r\n");
   WritePrivate(target,old);
   bool refused=false;try{WritePrivate(target,fresh);}catch(IOException){refused=true;}
   Check(refused&&File.ReadAllText(target)==Encoding.ASCII.GetString(old),"CreateNew collision refuses without truncating existing content");
   FileSecurity destination=Security(true);destination.SetOwner(WindowsIdentity.GetCurrent().User);
   File.SetAccessControl(target,destination);string before=Dacl(target);
   DirectorySecurity ds=new DirectorySecurity();ds.SetSecurityDescriptorSddlForm("O:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)");
   Directory.CreateDirectory(backupDir,ds);
   Check(Directory.GetAccessControl(backupDir).AreAccessRulesProtected,"backup directory protected at creation");
   WritePrivate(temp,fresh);
   Check(Dacl(temp)!=before,"replacement and destination ACLs differ for preservation test");
   File.Replace(temp,target,backup);
   Check(File.ReadAllText(target)==Encoding.ASCII.GetString(fresh),"atomic replacement publishes expected new bytes");
   Check(File.ReadAllText(backup)==Encoding.ASCII.GetString(old),"replacement preserves exact old bytes in backup");
   Check(Dacl(target)==before,"atomic replacement preserves destination DACL and owner");
   Check(!File.Exists(temp),"replacement consumes temporary file");
   Console.WriteLine("ALL PASS");return 0;
  }catch(Exception e){Console.WriteLine("FAIL "+e.GetType().Name+": "+e.Message);return 1;}
 }
}
