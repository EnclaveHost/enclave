// Framed private input staging and read-only held-inventory transport. Never
// resets an original attempt, retries a command or converts held into released.
using System;using System.Collections.Generic;using System.IO;using System.Text;using System.Web.Script.Serialization;
namespace Enclave.OwnedRpc {
 internal sealed partial class NativeRpcManagerLedger {
  internal void CheckOperation(){current();}
  internal Dictionary<string,object> Inspect(){
   current();Files.PinDirectory(Path.Combine(Root,"transport"),true);var names=new HashSet<string>();
   foreach(string path in Directory.EnumerateFileSystemEntries(Root)){
    current();string n=Path.GetFileName(path);if(n=="inputs"||n=="bootstrap")Files.PinDirectory(path,true);if(names.Count>=15||!names.Add(n)||n.EndsWith(".pending",StringComparison.Ordinal))throw new InvalidOperationException("Unknown or partial native ledger inventory");
    if(n!="manager.lock"&&n!="transport"&&n!="inputs"&&n!="attempt.json"&&n!="launch.json"&&n!="dispatch.json"&&n!="result.json"&&n!="hold.json"&&n!="stage.json"&&n!="stage-ready.json"&&n!="define-request.json"&&n!="start-request.json"&&n!="start-dispatch.json"&&n!="start-result.json"&&n!="bootstrap")throw new InvalidOperationException("Foreign native ledger inventory");
   }
   if(!names.Contains("attempt.json")){
    if(names.Count!=2||!names.Contains("manager.lock")||!names.Contains("transport"))throw new InvalidOperationException("Incomplete native ledger remains held");
    return new Dictionary<string,object>{{"state","empty"},{"reservationMayRelease",false}};
   }
   byte[] raw=Files.Read(Path.Combine(Root,"attempt.json"),4096,null);var a=Decode(raw);
   if(a.Count!=13||Text(a["schema"])!="native-rpc-manager-attempt/1"||Text(a["config"])!=ConfigHash||!(a["reservationMayRelease"] is bool)||(bool)a["reservationMayRelease"])throw new InvalidOperationException("Original native inventory binding differs");
   // This read intentionally survives expiry/reboot. It grants no original
   // mutation authority; Original() still checks boot and original deadline.
   object launch=null;if(names.Contains("launch.json"))launch=Decode(Files.Read(Path.Combine(Root,"launch.json"),65536,null));
   return new Dictionary<string,object>{{"state","held"},{"original",a},{"originalSha256",ProtectedAttempt.Hash(raw)},{"launch",launch},{"dispatchPresent",names.Contains("dispatch.json")},{"resultPresent",names.Contains("result.json")},{"reservationMayRelease",false}};
  }
  internal object Hold(string originalHash){
   var inventory=Inspect();if(Text(inventory["state"])!="held"||Text(inventory["originalSha256"])!=originalHash)throw new InvalidOperationException("Exact original hold required");
   Files.Publish(Path.Combine(Root,"hold.json"),Encode(new{original=originalHash,reservationMayRelease=false,providerOperationFenced=false}));return new{held=true,reservationMayRelease=false,providerOperationFenced=false};
  }
 }
 public static partial class NativeRpcControllerEntry {
#if !NATIVE_RPC_START_CONTROLLER
  static bool BytesEqual(byte[] a,byte[] b){if(a.Length!=b.Length)return false;for(int i=0;i<a.Length;i++)if(a[i]!=b[i])return false;return true;}
  static byte[] Exactly(Stream input,int count,Action guard){var b=new byte[count];int pos=0;while(pos<count){guard();int n=input.Read(b,pos,count-pos);if(n==0)throw new EndOfStreamException("Truncated native stage frame");pos+=n;}return b;}
  internal static object Stage(NativeRpcManagerLedger ledger,Dictionary<string,object> c,string originalHash,Stream input){
   var a=ledger.Original(originalHash);long originalOrigin=Int64.Parse(S(a["originMs"])),originalEnd=Int64.Parse(S(a["deadlineMs"]));Action guard=delegate{ledger.CheckOperation();long now=BoundedWorker.MonotonicMilliseconds();if(now<originalOrigin||now>=originalEnd)throw new InvalidOperationException("Original staging deadline expired");};
   // Consumed before even reading a possibly blocked/truncated pipe. A partial
   // producer cannot retry stage with replacement bytes or a new deadline.
   ledger.Files.Publish(Path.Combine(ledger.Root,"stage.json"),E(new{original=originalHash}));
   byte[] size=Exactly(input,4,guard);uint length=(uint)(size[0]|size[1]<<8|size[2]<<16|size[3]<<24);
   if(length<2||length>196608)throw new InvalidOperationException("Native stage header bound");
   var header=D(new JavaScriptSerializer{MaxJsonLength=196608,RecursionLimit=32}.DeserializeObject(new UTF8Encoding(false,true).GetString(Exactly(input,(int)length,guard))));
   if(header.Count!=3)throw new InvalidOperationException("Native stage fields");
   byte[] launchBytes=Encoding.UTF8.GetBytes(S(header["launch"])),recordBytes=Encoding.UTF8.GetBytes(S(header["record"]));
   if(launchBytes.Length>65536||recordBytes.Length>65536||!(header["bundleBytes"] is int))throw new InvalidOperationException("Native stage input bounds");
   int bundleBytes=(int)header["bundleBytes"];if(bundleBytes<1||bundleBytes>9*1048576)throw new InvalidOperationException("Native bundle bound");
   var launch=NativeRpcManagerLedger.Decode(launchBytes);var plan=MakePlan(a,c,launch);
   if(ProtectedAttempt.Hash(recordBytes)!=plan.Record)throw new InvalidOperationException("Exact canonical native record required");
   ledger.ConsumeLaunch(originalHash,launch);
   string root=Path.Combine(ledger.Root,"inputs");ledger.Files.NewDirectory(root);
   // Canonical native serializer form is also the ledger's stored launch form.
   byte[] savedLaunch=E(launch);ledger.Files.Publish(Path.Combine(root,"launch.json"),savedLaunch);ledger.Files.Publish(Path.Combine(root,"record.json"),recordBytes);
   using(var bounded=new StageStream(input,bundleBytes,guard))ledger.Files.Copy(Path.Combine(root,"bundle.bin"),bounded,bundleBytes,plan.App);
   guard();if(input.ReadByte()!=-1)throw new InvalidOperationException("Trailing native stage input");
   var ready=new Dictionary<string,object>{{"original",originalHash},{"launchSha256",ProtectedAttempt.Hash(savedLaunch)},{"recordSha256",plan.Record},{"bundleSha256",plan.App},{"bundleBytes",bundleBytes},{"reservationMayRelease",false}};
   ledger.Files.Publish(Path.Combine(ledger.Root,"stage-ready.json"),E(ready));return ready;
  }
  sealed class StageStream:Stream {
   readonly Stream source;readonly Action guard;long remaining;
   internal StageStream(Stream source,int length,Action guard){this.source=source;remaining=length;this.guard=guard;}
   public override int Read(byte[] buffer,int offset,int count){guard();if(remaining==0)return 0;int n=source.Read(buffer,offset,(int)Math.Min(count,remaining));if(n==0)throw new EndOfStreamException("Truncated native bundle");remaining-=n;return n;}
   public override bool CanRead{get{return true;}}public override bool CanWrite{get{return false;}}public override bool CanSeek{get{return false;}}
   public override long Length{get{throw new NotSupportedException();}}public override long Position{get{throw new NotSupportedException();}set{throw new NotSupportedException();}}
   public override void Flush(){throw new NotSupportedException();}public override long Seek(long o,SeekOrigin x){throw new NotSupportedException();}public override void SetLength(long x){throw new NotSupportedException();}public override void Write(byte[] b,int o,int n){throw new NotSupportedException();}
  }
  static object DefineStaged(NativeRpcManagerLedger ledger,Dictionary<string,object> c,string originalHash){
   ledger.Original(originalHash);var ready=NativeRpcManagerLedger.Decode(ledger.Files.Read(Path.Combine(ledger.Root,"stage-ready.json"),4096,null));
   if(ready.Count!=6||S(ready["original"])!=originalHash||!(ready["reservationMayRelease"] is bool)||(bool)ready["reservationMayRelease"])throw new InvalidOperationException("Original complete staging required");
   ledger.Files.Publish(Path.Combine(ledger.Root,"define-request.json"),E(new{original=originalHash,stage=ProtectedAttempt.Hash(E(ready))}));
   string root=Path.Combine(ledger.Root,"inputs");return Define(ledger,c,originalHash,Path.Combine(root,"launch.json"),S(ready["launchSha256"]),Path.Combine(root,"bundle.bin"),Path.Combine(root,"record.json"),true);
  }
#endif
 }
}
