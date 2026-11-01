// Fixed native bridge for HostBootstrapEntry. Not a daemon, launcher fallback,
// VM owner proof, or default activation. Native target qualification outstanding.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace Enclave.OwnedRpc {
 public sealed partial class ProtectedAttempt {
  void BootstrapParents(string path) {
   LocalPath(path);string dir=Path.GetDirectoryName(path),current=Path.GetPathRoot(dir);
   HoldDirectory(current,false);string[] parts=dir.Substring(3).Split('\\');
   for(int i=0;i<parts.Length;i++){current=Path.Combine(current,parts[i]);HoldDirectory(current,i==parts.Length-1);}
  }
  internal void BootstrapPin(string path,int maximum,string digest) {
   if(LeaseProfile!="host-bootstrap")throw new InvalidOperationException("Bootstrap profile required");
   CheckDeadline();Hex(digest,64);BootstrapParents(path);
   var stream=HoldRead(path,maximum);string actual;
   using(var sha=SHA256.Create())actual=BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant();
   if(actual!=digest)throw new InvalidOperationException("Bootstrap executable pin differs");CheckDeadline();
  }
  internal byte[] BootstrapRead(string path,int maximum,string digest) {
   if(LeaseProfile!="host-bootstrap")throw new InvalidOperationException("Bootstrap profile required");
   CheckDeadline();BootstrapParents(path);
   byte[] raw=Bytes(HoldRead(path,maximum),maximum);
   if(digest!=null){Hex(digest,64);if(Hash(raw)!=digest)throw new InvalidOperationException("Bootstrap pin differs");}
   CheckDeadline();return raw;
  }
  internal void BootstrapPublish(string name,byte[] value) {
   if(LeaseProfile!="host-bootstrap"||(name!="enrollment.json"&&name!="native-result.json")||value.Length==0||value.Length>131072)
    throw new InvalidOperationException("Fixed public bootstrap record required");
   CheckDeadline();string final=Path.Combine(Root,name),pending=final+".pending";
   var security=new FileSecurity();security.SetSecurityDescriptorSddlForm("O:SYG:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)");
   using(var f=new FileStream(pending,FileMode.CreateNew,FileSystemRights.Write,FileShare.None,4096,FileOptions.WriteThrough,security)){
    f.Write(value,0,value.Length);f.Flush(true);
   }
   File.Move(pending,final);BootstrapRead(final,131072,Hash(value));
  }
 }
}
