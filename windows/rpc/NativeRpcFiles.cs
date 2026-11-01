// Explicit native manager controller. No default manager activation, VM adoption,
// start, delete, release or retry. Each command has its own native 30s backstop;
// every definition remains inside the persisted original 900s attempt.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;
namespace Enclave.OwnedRpc {
 internal sealed class NativeControllerFiles:IDisposable {
  readonly List<IDisposable> held=new List<IDisposable>();readonly Action current;
  static readonly SecurityIdentifier Admin=new SecurityIdentifier("S-1-5-32-544"),SystemSid=new SecurityIdentifier("S-1-5-18");
  internal NativeControllerFiles(Action current){if(current==null)throw new ArgumentNullException("current");this.current=current;}
  internal void PinDirectory(string path,bool strict){
   current();ProtectedAttempt.LocalPath(path);string drive=Path.GetPathRoot(path),p=drive;
   HoldDirectory(drive,false);
   foreach(string part in path.Substring(3).Split('\\')){p=Path.Combine(p,part);HoldDirectory(p,strict&&p==path);}
  }
  void HoldDirectory(string path,bool strict){
   var h=ProtectedAttempt.CreateFile(path,0x200a0,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
   if(h.IsInvalid){h.Dispose();throw new Win32Exception(Marshal.GetLastWin32Error());}
   try{ProtectedAttempt.Authority(h,strict,true,path);held.Add(h);}catch{h.Dispose();throw;}
  }
  internal void NewDirectory(string path){
   current();ProtectedAttempt.LocalPath(path);PinDirectory(Path.GetDirectoryName(path),true);
   // The consumed original ledger precedes creation. Existing directories are
   // never an invitation to resume preparation or adopt their content.
   if(Directory.Exists(path)||File.Exists(path))throw new InvalidOperationException("Consumed controller directory");
   var acl=new DirectorySecurity();acl.SetOwner(Admin);acl.SetAccessRuleProtection(true,false);
   foreach(var sid in new[]{Admin,SystemSid})acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
   Directory.CreateDirectory(path,acl);HoldDirectory(path,true);current();
  }
  internal FileStream Open(string path,int maximum,bool exclusive){
   current();ProtectedAttempt.LocalPath(path);PinDirectory(Path.GetDirectoryName(path),true);
   var h=ProtectedAttempt.CreateFile(path,0x80000000|0x20000,exclusive?0U:1U,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
   if(h.IsInvalid){h.Dispose();throw new Win32Exception(Marshal.GetLastWin32Error());}
   FileStream f=null;
   try{ProtectedAttempt.Authority(h,true,false,path);if(AncestorCustody.Identity(h).Links!=1)throw new InvalidOperationException("Single-link controller input required");
    f=new FileStream(h,FileAccess.Read);if(f.Length<0||f.Length>maximum)throw new InvalidOperationException("Controller input bound");held.Add(f);return f;
   }catch{if(f!=null)f.Dispose();else h.Dispose();throw;}
  }
  internal byte[] Read(string path,int maximum,string digest){
   var f=Open(path,maximum,false);if(f.Length==0)throw new InvalidOperationException("Empty controller input");var b=new byte[(int)f.Length];int pos=0;
   while(pos<b.Length){current();int n=f.Read(b,pos,b.Length-pos);if(n==0)throw new IOException("Short controller input");pos+=n;}
   if(digest!=null&&ProtectedAttempt.Hash(b)!=digest)throw new InvalidOperationException("Controller input digest differs");current();return b;
  }
  static FileSecurity Security(){var acl=new FileSecurity();acl.SetOwner(Admin);acl.SetAccessRuleProtection(true,false);foreach(var sid in new[]{Admin,SystemSid})acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,AccessControlType.Allow));return acl;}
  internal void Publish(string path,byte[] bytes){using(var input=new MemoryStream(bytes,false))Copy(path,input,bytes.Length,ProtectedAttempt.Hash(bytes));}
  internal void Copy(string path,Stream input,int maximum,string digest){
   current();ProtectedAttempt.LocalPath(path);PinDirectory(Path.GetDirectoryName(path),true);
   string pending=path+".pending";
   using(var output=new FileStream(pending,FileMode.CreateNew,FileSystemRights.WriteData|FileSystemRights.ReadPermissions,FileShare.None,65536,FileOptions.WriteThrough,Security()))
   using(var hash=SHA256.Create()){
    ProtectedAttempt.Authority(output.SafeFileHandle,true,false,pending);long count=0;var buffer=new byte[65536];int n;
    while((n=input.Read(buffer,0,buffer.Length))!=0){current();count+=n;if(count>maximum)throw new InvalidOperationException("Controller copy bound");output.Write(buffer,0,n);hash.TransformBlock(buffer,0,n,buffer,0);}
    hash.TransformFinalBlock(new byte[0],0,0);if(count<1||BitConverter.ToString(hash.Hash).Replace("-","").ToLowerInvariant()!=digest)throw new InvalidOperationException("Controller copied digest differs");output.Flush(true);
   }
   // No overwrite. Torn pending records consume the operation, including empty.
   current();File.Move(pending,path);current();
  }
  internal string CopyMedia(string path,FileStream input,NativeRpcMediaProfile profile,bool tree){
   current();ProtectedAttempt.LocalPath(path);PinDirectory(Path.GetDirectoryName(path),true);
   if(Path.GetFileName(path)!=NativeRpcMediaProfile.Name(tree))throw new InvalidOperationException("Fixed optical destination required");
   string pending=path+".pending",digest;
   using(var output=new FileStream(pending,FileMode.CreateNew,FileSystemRights.WriteData|FileSystemRights.ReadPermissions,FileShare.None,1048576,FileOptions.WriteThrough,Security())){
    ProtectedAttempt.Authority(output.SafeFileHandle,true,false,pending);
    digest=profile.Verify(input,tree,current,output);output.Flush(true);
   }
   current();File.Move(pending,path);current();return digest;
  }
  public void Dispose(){for(int i=held.Count-1;i>=0;i--)held[i].Dispose();held.Clear();}
 }
}
