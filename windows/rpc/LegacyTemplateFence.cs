// Durable post-fence definition barrier for the EXACT old VMGS read/copy path.
// Not a start/provider settlement proof. No automatic unfence, reset or retry.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;
namespace Enclave.OwnedRpc {
 public sealed class LegacyTemplateFence {
  [StructLayout(LayoutKind.Sequential,Pack=4)] struct Info {
   public uint Attributes; public long Created,Accessed,Written;
   public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
  }
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info value);
  static void Check(long deadline){if(BoundedWorker.MonotonicMilliseconds()>=deadline)throw new InvalidOperationException("Template fence deadline");}
  static Info Identity(SafeFileHandle h){Info i;if(!GetFileInformationByHandle(h,out i))throw new Win32Exception(Marshal.GetLastWin32Error());return i;}
  static string Key(Info i){return i.Volume.ToString("x8")+":"+i.IndexHigh.ToString("x8")+i.IndexLow.ToString("x8");}
  static void PinParents(string file,List<SafeFileHandle> held){
   string dir=Path.GetDirectoryName(file),current=Path.GetPathRoot(dir);
   var paths=new List<string>();paths.Add(current);
   foreach(string part in dir.Substring(3).Split('\\')){current=Path.Combine(current,part);paths.Add(current);}
   for(int n=0;n<paths.Count;n++){
    var h=ProtectedAttempt.CreateFile(paths[n],0x20000|0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
    if(h.IsInvalid){int e=Marshal.GetLastWin32Error();h.Dispose();throw new Win32Exception(e);}
    held.Add(h);ProtectedAttempt.Authority(h,n==paths.Count-1,true,paths[n]);
   }
  }
  // Caller is a separately bounded protected owner worker; this class creates
  // no process, task, VM or provider operation. Receipt deliberately cannot admit.
  public sealed class Receipt {
   public string ObjectIdentity,MasterHash,IntentHash;
   public bool PersistentReadDenial;
   public bool ExistingOperationsSettled {get{return false;}}
   public bool ReservationMayRelease {get{return false;}}
  }
  public static Receipt Apply(string master,string expectedHash,long expectedLength,string expectedBoot,string intentPath,long deadline){
   ProtectedAttempt.RequireAdministrator();ProtectedAttempt.LocalPath(master);ProtectedAttempt.LocalPath(intentPath);
   StartIdentity.Hex(expectedHash,64);StartIdentity.Hex(expectedBoot,32);
   if(!master.EndsWith(".vmgs",StringComparison.OrdinalIgnoreCase)||Path.GetFileName(intentPath)!="definition-fence.intent"||
      String.Equals(Path.GetDirectoryName(master),Path.GetDirectoryName(intentPath),StringComparison.OrdinalIgnoreCase))
    throw new ArgumentException("Separate protected intent namespace and exact VMGS file required");
   long now=BoundedWorker.MonotonicMilliseconds();
   if(deadline<=now||deadline-now>10000||expectedLength<1||expectedLength>16*1024*1024)throw new ArgumentException("Finite small-template operation required");
   if(ProtectedAttempt.CurrentBoot()!=expectedBoot)throw new InvalidOperationException("Template fence boot differs");
   var parents=new List<SafeFileHandle>();
   try{
    PinParents(master,parents);PinParents(intentPath,parents);Check(deadline);
    // Exclusive content open excludes preexisting content readers/writers and
    // replacement while applying. Already copied templates remain OUTSIDE this barrier.
    var h=ProtectedAttempt.CreateFile(master,0x80000000|0x20000|0x40000,0,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
    if(h.IsInvalid){int e=Marshal.GetLastWin32Error();h.Dispose();throw new Win32Exception(e);}
    using(var stream=new FileStream(h,FileAccess.Read)){
     ProtectedAttempt.Authority(h,true,false,master);Info before=Identity(h);
     if(before.Links!=1||stream.Length!=expectedLength)throw new InvalidOperationException("Aliased or resized template refused");
     byte[] bytes=new byte[(int)expectedLength];int at=0;
     while(at<bytes.Length){Check(deadline);int n=stream.Read(bytes,at,bytes.Length-at);if(n==0)throw new IOException("Short template");at+=n;}
     if(stream.ReadByte()!=-1||ProtectedAttempt.Hash(bytes)!=expectedHash)throw new InvalidOperationException("Template hash differs");
     var security=stream.GetAccessControl();string original=security.GetSecurityDescriptorSddlForm(AccessControlSections.Access|AccessControlSections.Owner|AccessControlSections.Group);
     if(original.Length>32768)throw new InvalidOperationException("Template descriptor bound");
     var world=new SecurityIdentifier("S-1-1-0");
     security.AddAccessRule(new FileSystemAccessRule(world,FileSystemRights.ReadData,AccessControlType.Deny));
     security.SetAccessRuleProtection(true,true);
     string wanted=security.GetSecurityDescriptorSddlForm(AccessControlSections.Access);
     string record="legacy-template-fence/1\n"+expectedBoot+"\n"+master+"\n"+Key(before)+"\n"+expectedHash+"\n"+expectedLength+"\n"+Convert.ToBase64String(Encoding.UTF8.GetBytes(original))+"\n";
     byte[] intent=Encoding.UTF8.GetBytes(record);
     var sec=new FileSecurity();sec.SetAccessRuleProtection(true,false);
     string owner;using(var who=WindowsIdentity.GetCurrent())owner=who.User.Value=="S-1-5-18"?"S-1-5-18":"S-1-5-32-544";
     sec.SetOwner(new SecurityIdentifier(owner));
     foreach(string sid in new[]{"S-1-5-18","S-1-5-32-544"})sec.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,AccessControlType.Allow));
     Check(deadline);
     // Consumed intent precedes mutation and survives any lost response. CreateNew
     // refuses reuse. No catch restores the DACL, even when readback fails.
     using(var journal=new FileStream(intentPath,FileMode.CreateNew,FileSystemRights.WriteData|FileSystemRights.ReadPermissions,FileShare.Read,4096,FileOptions.WriteThrough,sec)){
      ProtectedAttempt.Authority(journal.SafeFileHandle,true,false,intentPath);
      journal.Write(intent,0,intent.Length);journal.Flush(true);Check(deadline);
      stream.SetAccessControl(security);Check(deadline);
      if(Key(Identity(h))!=Key(before)||stream.GetAccessControl().GetSecurityDescriptorSddlForm(AccessControlSections.Access)!=wanted)
       throw new InvalidOperationException("Template fence readback differs; keep outcome held");
     }
     return new Receipt{ObjectIdentity=Key(before),MasterHash=expectedHash,IntentHash=ProtectedAttempt.Hash(intent),PersistentReadDenial=true};
    }
   }finally{foreach(var h in parents)h.Dispose();}
  }
 }
}
