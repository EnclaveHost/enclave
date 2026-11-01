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
 public static class HostBootstrapChannels {
  static readonly UTF8Encoding Utf8=new UTF8Encoding(false,true);
  internal static readonly string[] SourceNames=ProtectedAttempt.BootstrapSourceNames;
  [DllImport("ws2_32.dll")] static extern int WSAStartup(ushort version,IntPtr data);
  [DllImport("ws2_32.dll")] static extern IntPtr socket(int family,int type,int protocol);
  [DllImport("ws2_32.dll")] static extern int setsockopt(IntPtr s,int level,int option,ref int value,int length);
  [DllImport("ws2_32.dll")] static extern int connect(IntPtr s,ref HvAddress address,int length);
  [DllImport("ws2_32.dll")] static extern int getpeername(IntPtr s,out HvAddress address,ref int length);
  [DllImport("ws2_32.dll")] static extern int recv(IntPtr s,byte[] data,int length,int flags);
  [DllImport("ws2_32.dll")] static extern int send(IntPtr s,byte[] data,int length,int flags);
  [DllImport("ws2_32.dll")] static extern int WSAGetLastError();
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [StructLayout(LayoutKind.Sequential)] struct HvAddress {public ushort Family,Reserved;public Guid Vm,Service;}
  // The socket is process-lifetime owned. Never close it while a pump can be in
  // recv/send: teardown by the independent job avoids native handle reuse races.
  static IntPtr Dial(Guid vm,Action current) {
   current();if(vm==Guid.Empty)throw new ArgumentException("Exact nonempty partition required");
   IntPtr data=Marshal.AllocHGlobal(512);try{int error=WSAStartup(0x0202,data);if(error!=0)throw new Win32Exception(error);}finally{Marshal.FreeHGlobal(data);}
   IntPtr s=socket(34,1,1);if(s==new IntPtr(-1))throw new Win32Exception(WSAGetLastError());
   if(!SetHandleInformation(s,1,0))throw new Win32Exception(Marshal.GetLastWin32Error());
   int timeout=3000;if(setsockopt(s,1,1,ref timeout,4)!=0)throw new Win32Exception(WSAGetLastError());
   var address=new HvAddress{Family=34,Vm=vm,Service=new Guid("00002328-facb-11e6-bd58-64006a7986d3")};
   if(Marshal.SizeOf(typeof(HvAddress))!=36||connect(s,ref address,36)!=0)throw new Win32Exception(WSAGetLastError());
   HvAddress peer;int size=36;
   if(getpeername(s,out peer,ref size)!=0||size!=36||peer.Family!=34||peer.Reserved!=0||peer.Vm!=vm||peer.Service!=address.Service)
    throw new InvalidOperationException("Exact Hyper-V peer differs");
   current();return s;
  }
  static int MonitorRead(IntPtr handle,byte[] bytes) {
#if RPC_BOOTSTRAP_CI
   return HostBootstrapFixture.Read(bytes);
#else
   return recv(handle,bytes,bytes.Length,0);
#endif
  }
  static int MonitorWrite(IntPtr handle,byte[] bytes) {
#if RPC_BOOTSTRAP_CI
   return HostBootstrapFixture.Write(bytes);
#else
   return send(handle,bytes,bytes.Length,0);
#endif
  }
  static long Number(string s){return Int64.Parse(s,NumberStyles.None,CultureInfo.InvariantCulture);}
  static string Q(string value){ProtectedAttempt.LocalPath(value);return "\""+value+"\"";}
  static byte[] Json(object value){return Utf8.GetBytes(new JavaScriptSerializer{MaxJsonLength=1048576}.Serialize(value));}
  static byte[] ExactRead(Stream input,int count){var b=new byte[count];int at=0;while(at<count){int n=input.Read(b,at,count-at);if(n<=0)throw new EndOfStreamException("Native frame lost");at+=n;}return b;}
  internal static byte[] ReadFrame(Stream input,out int lane) {
   byte[] h=ExactRead(input,5);lane=h[0];uint n=((uint)h[1]<<24)|((uint)h[2]<<16)|((uint)h[3]<<8)|h[4];
   if(lane>2||n==0||n>(lane==0?131072:32768))throw new InvalidOperationException("Native frame bound");
   return ExactRead(input,(int)n);
  }
  static Process Start(string executable,string args,string root,Action current) {
   current();bool member;if(!IsProcessInJob(GetCurrentProcess(),IntPtr.Zero,out member)||!member)throw new InvalidOperationException("Contained parent required before children");
   var si=new ProcessStartInfo(executable,args){UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=root,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};
   si.EnvironmentVariables.Clear();string os=Environment.GetEnvironmentVariable("SystemRoot");
   si.EnvironmentVariables["SystemRoot"]=os;si.EnvironmentVariables["WINDIR"]=os;si.EnvironmentVariables["TEMP"]=root;si.EnvironmentVariables["TMP"]=root;
   // No breakaway: parent was assigned before this CreateProcess call. Every
   // process inherits its parent's job chain. The independent observer owns it.
   var p=Process.Start(si);IntPtr held=p.Handle;
   if(!IsProcessInJob(held,IntPtr.Zero,out member)||!member||p.HasExited)throw new InvalidOperationException("Child membership/liveness differs");
   current();return p; // retained by Run; never PID-based reopening/termination
  }
  static void Pump(Action work){new Thread(delegate(){try{work();}catch{if(!TerminateProcess(GetCurrentProcess(),126))Environment.FailFast("Native channel failure");}}){IsBackground=true}.Start();}
  static void Drain(Process p){Pump(delegate{byte[] b=new byte[4096];int total=0,n;while((n=p.StandardError.BaseStream.Read(b,0,b.Length))>0){total+=n;if(total>65536)throw new InvalidOperationException("Private diagnostic bound");}});}
  public static int Run(ProtectedAttempt a,Action current) {
   current();if(a.LeaseProfile!="host-bootstrap")throw new InvalidOperationException("Explicit bootstrap required");
   BoundedWorker.EnterSupervisorEnvelope(128UL*1048576);
   string[] f=Utf8.GetString(a.BootstrapRead(a.PermitPath,131072,a.PermitHash)).Split('\n');
   // Fixed line plan, no generic executable/command transport. Original startup
   // clock is distinct from this <=30s phase lease and is never refreshed here.
   #if RPC_BOOTSTRAP_CI
   if(f.Length!=16||f[0]!="owned-rpc-host-plan-v1"||f[15]!="")throw new InvalidOperationException("Exact fixture bootstrap plan required");
#else
   // The native process owns these handles until teardown; never dispose them
   // while background pumps may be executing Check(). No PID reopen on loss.
   NativeBootstrapBinding.Shape(f);var original=new NativeBootstrapContext(a,f,current);current=original.Check;
#endif
   Guid vm;if(!Guid.TryParseExact(f[1],"D",out vm)||vm==Guid.Empty||vm.ToString("D")!=f[1])throw new ArgumentException("Canonical VM GUID required");
   long origin=Number(f[2]),deadline=Number(f[3]);
   if(origin<0||origin>Int64.MaxValue-900000||deadline-origin!=900000||a.Origin<origin||a.Deadline>deadline)throw new InvalidOperationException("Original startup clock differs");
   // Inputs remain read-locked with all ancestors held until process teardown.
   a.BootstrapPin(f[4],134217728,f[5]);a.BootstrapPin(f[6],1048576,f[7]);
   byte[] key=a.BootstrapRead(f[8],16384,f[9]);
   string root=ProtectedAttempt.LocalPath(f[10]);
   string[] pins=Utf8.GetString(a.BootstrapRead(Path.Combine(root,"bootstrap-source.txt"),65536,f[11])).Split('\n');
   if(pins.Length!=SourceNames.Length+1||pins[pins.Length-1]!="")throw new InvalidOperationException("Exact source closure required");
   for(int i=0;i<SourceNames.Length;i++){
    string[] pin=pins[i].Split('|');if(pin.Length!=2||pin[0]!=SourceNames[i])throw new InvalidOperationException("Source closure name differs");
    a.BootstrapRead(Path.Combine(root,SourceNames[i].Replace('/','\\')),262144,pin[1]);
   }
   byte[] expected=Convert.FromBase64String(f[12]),chain=Convert.FromBase64String(f[13]);
   if(expected.Length>32768||chain.Length>65536||Convert.ToBase64String(expected)!=f[12]||Convert.ToBase64String(chain)!=f[13])throw new InvalidOperationException("Public configuration bound");
   // Production NativeBootstrapContext already verified this digest against
   // the original owned/start journal; historical ambiguous attempts cannot pass.
   if(f[14].Length!=64||!System.Text.RegularExpressions.Regex.IsMatch(f[14],"\\A[0-9a-f]{64}\\z"))throw new InvalidOperationException("Original VM ownership receipt required");
   a.WriteOnce("bootstrap.native-intent",a.Token+","+f[1]+","+f[14]+","+origin+","+deadline);
#if RPC_BOOTSTRAP_CI
   // Separate hosted-fixture binary only. Production has no selectable fake
   // channel, alternate endpoint or injected command implementation.
   HostBootstrapFixture.Open(a.Root);IntPtr hv=IntPtr.Zero;
#else
   IntPtr hv=Dial(vm,current);
#endif
   Process tpm=Start(f[6],"",a.Root,current),node=Start(f[4],"--no-addons --max-old-space-size=48 "+Q(Path.Combine(root,"rpc\\host\\windows-entry.mjs")),a.Root,current);
   a.WriteOnce("bootstrap.children",tpm.Id+","+tpm.StartTime.ToUniversalTime().ToFileTimeUtc()+","+
    node.Id+","+node.StartTime.ToUniversalTime().ToFileTimeUtc()+","+a.Token);
   Drain(tpm);Drain(node);object outputLock=new object();Stream output=node.StandardInput.BaseStream;
   Action<int,byte[]> emit=delegate(int lane,byte[] raw){
    current();if(raw.Length==0||raw.Length>(lane==0?131072:32768))throw new InvalidOperationException("Native output frame bound");
    byte[] h={(byte)lane,(byte)(raw.Length>>24),(byte)(raw.Length>>16),(byte)(raw.Length>>8),(byte)raw.Length};
    lock(outputLock){output.Write(h,0,5);output.Write(raw,0,raw.Length);output.Flush();}
   };
   int channel;byte[] first=ReadFrame(node.StandardOutput.BaseStream,out channel);
   if(channel!=0||Utf8.GetString(first)!="clock")throw new InvalidOperationException("Clock handshake required before transport");
   var serializer=new JavaScriptSerializer{MaxJsonLength=131072};
   emit(0,Json(new Dictionary<string,object>{{"schema","rpc-native-clock/1"},{"token",a.Token},{"boot",a.Boot},{"vmGuid",f[1]},
    {"originMs",origin.ToString(CultureInfo.InvariantCulture)},{"deadlineMs",deadline.ToString(CultureInfo.InvariantCulture)},
    {"phaseDeadlineMs",a.Deadline.ToString(CultureInfo.InvariantCulture)},{"sampleMs",BoundedWorker.MonotonicMilliseconds().ToString(CultureInfo.InvariantCulture)},
    {"journal",Path.Combine(a.Root,"host-journal.jsonl")},{"privateKeyPem",Utf8.GetString(key)},
    {"expected",serializer.DeserializeObject(Utf8.GetString(expected))},{"ekChain",serializer.DeserializeObject(Utf8.GetString(chain))}}));
   Array.Clear(key,0,key.Length);long receivedMonitor=0,receivedTpm=0;
   Pump(delegate{for(;;){byte[] b=new byte[32768];int n=MonitorRead(hv,b);if(n<=0)throw new EndOfStreamException("Hyper-V channel lost");receivedMonitor+=n;if(receivedMonitor>262144)throw new InvalidOperationException("Monitor aggregate bound");Array.Resize(ref b,n);emit(1,b);}});
   Pump(delegate{for(;;){byte[] b=new byte[32768];int n=tpm.StandardOutput.BaseStream.Read(b,0,b.Length);if(n<=0)throw new EndOfStreamException("TPM process lost");receivedTpm+=n;if(receivedTpm>524288)throw new InvalidOperationException("TPM aggregate bound");Array.Resize(ref b,n);emit(2,b);}});
   bool enrolled=false,offered=false;long sentMonitor=0,sentTpm=0;
   for(;;){
    current();byte[] raw=ReadFrame(node.StandardOutput.BaseStream,out channel);
    if(channel==1){sentMonitor+=raw.Length;if(sentMonitor>13L*1048576)throw new InvalidOperationException("Monitor input aggregate bound");int at=0;while(at<raw.Length){byte[] part=new byte[raw.Length-at];Buffer.BlockCopy(raw,at,part,0,part.Length);int n=MonitorWrite(hv,part);if(n<=0)throw new Win32Exception(WSAGetLastError());at+=n;}continue;}
    if(channel==2){sentTpm+=raw.Length;if(sentTpm>65536)throw new InvalidOperationException("TPM input aggregate bound");tpm.StandardInput.BaseStream.Write(raw,0,raw.Length);tpm.StandardInput.BaseStream.Flush();continue;}
    string text=Utf8.GetString(raw);
    if(text.StartsWith("enroll\n",StringComparison.Ordinal)&&!enrolled){
     enrolled=true;a.BootstrapPublish("enrollment.json",Json(new Dictionary<string,object>{{"token",a.Token},{"vmGuid",f[1]},{"ownershipReceiptSha256",f[14]},{"originalOriginMs",f[2]},{"originalDeadlineMs",f[3]},{"enrollment",serializer.DeserializeObject(text.Substring(7))}}));
     string offer=Path.Combine(a.Root,"owner-offer.json");
     while(!File.Exists(offer)){current();Thread.Sleep(5);}
     byte[] offeredBytes=a.BootstrapRead(offer,131072,null);a.WriteOnce("owner-offer.consumed",ProtectedAttempt.Hash(offeredBytes));
     offered=true;emit(0,offeredBytes);continue;
    }
    if(text=="acquisition-requested"&&enrolled&&offered){
     a.BootstrapPublish("native-result.json",Json(new Dictionary<string,object>{{"token",a.Token},{"acquisitionRequested",true},{"rpcReady",false},{"providerOperationFenced",false},{"reservationMayRelease",false}}));
     // RunGuarded owns exact worker/tree cleanup after return. Never label this
     // protocol acknowledgment as native death, VM readiness or writer fencing.
     GC.KeepAlive(node);GC.KeepAlive(tpm);return 0;
    }
    throw new InvalidOperationException("Unexpected or repeated native control frame");
   }
  }
 }
}
