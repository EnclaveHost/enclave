// Exact start-group custody for native cleanup. Accepts only preheld handles
// transferred by the independent lifecycle owner; never opens a numeric PID.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;
namespace Enclave.OwnedRpc {
 public sealed partial class ProtectedAttempt {
  internal string PinNativeStartGroup(string path,string hash){
   if((LeaseProfile!="native-cleanup-journal"&&LeaseProfile!="native-lifecycle-journal"))throw new InvalidOperationException("Cleanup custody required");
   CheckDeadline();LocalPath(path);Hex(hash,64);if(Path.GetFileName(path)!="contract.txt")throw new ArgumentException("Fixed start worker contract path");
   string root=Path.GetDirectoryName(path),current=Path.GetPathRoot(root);HoldDirectory(current,false);string[] parts=root.Substring(3).Split('\\');
   for(int i=0;i<parts.Length;i++){current=Path.Combine(current,parts[i]);HoldDirectory(current,i==parts.Length-1);}
   byte[] raw=Bytes(HoldRead(path,2048),2048);if(Hash(raw)!=hash)throw new InvalidOperationException("Original start worker contract differs");
   var f=Utf8.GetString(raw).Split('\n');var p=NativeDefinitionPlan;
   if(f.Length!=10||f[0]!="owned-native-rpc-start-worker-v1"||f[6]!="start"||f[7]!=Path.Combine(Root,"native-definition-plan.txt")||f[8]!=ContractHash||f[9]!="")throw new InvalidOperationException("Exact original start worker contract required");
   Hex(f[1],32);Hex(f[2],32);Hex(f[5],64);long origin=Int64.Parse(f[3],NumberStyles.None,CultureInfo.InvariantCulture),end=Int64.Parse(f[4],NumberStyles.None,CultureInfo.InvariantCulture);
   if(Path.GetFileName(root)!=f[1]||root==Root||f[2]!=p.Boot||f[5]!=p.WorkerImageHash||origin<p.Origin||end<=origin||end-origin>30000||end>p.Deadline)throw new InvalidOperationException("Original start worker identity/window differs");
   if(Hash(Bytes(HoldRead(Path.Combine(root,"entry.exe"),262144),262144))!=p.WorkerImageHash)throw new InvalidOperationException("Original start worker image differs");CheckDeadline();return f[1]+f[2]+hash;
  }
  internal string PinNativeStartPeer(string contract,string role){
   if((LeaseProfile!="native-cleanup-journal"&&LeaseProfile!="native-lifecycle-journal")||(role!="owner"&&role!="observer"&&role!="child"))throw new ArgumentException("Exact start peer role");
   CheckDeadline();return Utf8.GetString(Bytes(HoldRead(Path.Combine(Path.GetDirectoryName(contract),role+".consumed"),4096),4096));
  }
 }
}
