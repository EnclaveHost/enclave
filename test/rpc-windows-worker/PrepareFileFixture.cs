// Inert qualification only. Creates fresh marked dummy files, never a VM or cut.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
namespace Enclave.OwnedRpc {
 public static class PrepareFileFixture {
  static long Origin,Deadline,OriginalOrigin,OriginalDeadline;
  static readonly List<IDisposable> Held=new List<IDisposable>();
  static readonly SecurityIdentifier Admin=new SecurityIdentifier("S-1-5-32-544"),SystemIdentity=new SecurityIdentifier("S-1-5-18");
  static readonly UTF8Encoding Utf8=new UTF8Encoding(false,true);
  static readonly JavaScriptSerializer Json=new JavaScriptSerializer{MaxJsonLength=8192};
  [StructLayout(LayoutKind.Sequential)] struct Memory {public uint Length,Load;public ulong Total,Available,PageTotal,PageAvailable,VirtualTotal,VirtualAvailable,Extended;}
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {public int Length;public IntPtr Descriptor;public int Inherit;}
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GlobalMemoryStatusEx(ref Memory memory);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetDiskFreeSpaceExW(string path,out ulong available,out ulong total,out ulong free);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateDirectoryW(string path,ref SecurityAttributes attributes);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  static void Check(){long now=BoundedWorker.MonotonicMilliseconds();if(now<Origin||now>=Deadline)throw new TimeoutException("Original fixture lease expired");}
  static void Arm(){var ready=new ManualResetEvent(false);new Thread(delegate(){ready.Set();while(BoundedWorker.MonotonicMilliseconds()<Deadline)Thread.Sleep(5);if(!TerminateProcess(GetCurrentProcess(),124))Environment.FailFast("Fixture deadline termination failed");}){IsBackground=true}.Start();if(!ready.WaitOne(1000))throw new TimeoutException("Fixture watchdog not armed");Check();}
  static void Hex(string value,int n){if(value==null||!Regex.IsMatch(value,"\\A[0-9a-f]{"+n+"}\\z"))throw new ArgumentException("Exact hexadecimal identity required");}
  static string Hash(byte[] bytes){return ProtectedAttempt.Hash(bytes);}
  static byte[] Bytes(string text){return Utf8.GetBytes(text);}
  static void Hold(string path,bool strict){var handle=ProtectedAttempt.CreateFile(path,0x20080,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);if(handle.IsInvalid){handle.Dispose();throw new Win32Exception(Marshal.GetLastWin32Error());}Held.Add(handle);ProtectedAttempt.Authority(handle,strict,true,path);Check();}
  static void HoldNamespace(string path){ProtectedAttempt.LocalPath(path);Hold(@"C:\",false);string current=@"C:\";string[] parts=path.Substring(3).Split('\\');for(int i=0;i<parts.Length;i++){current=Path.Combine(current,parts[i]);Hold(current,i==parts.Length-1);}}
  static void DirectoryNew(string path){
   Check();var acl=new DirectorySecurity();acl.SetOwner(Admin);acl.SetAccessRuleProtection(true,false);
   foreach(var sid in new[]{Admin,SystemIdentity})acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
   byte[] raw=acl.GetSecurityDescriptorBinaryForm();IntPtr memory=Marshal.AllocHGlobal(raw.Length);
   try{Marshal.Copy(raw,0,memory,raw.Length);var attrs=new SecurityAttributes{Length=Marshal.SizeOf(typeof(SecurityAttributes)),Descriptor=memory};if(!CreateDirectoryW(path,ref attrs))throw new Win32Exception(Marshal.GetLastWin32Error());}finally{Marshal.FreeHGlobal(memory);}
   Hold(path,true);
  }
  static void Write(string path,byte[] bytes){
   Check();if(bytes.Length>32768)throw new InvalidOperationException("Fixed dummy byte bound");
   var acl=new FileSecurity();acl.SetOwner(Admin);acl.SetAccessRuleProtection(true,false);
   foreach(var sid in new[]{Admin,SystemIdentity})acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,AccessControlType.Allow));
   using(var file=new FileStream(path,FileMode.CreateNew,FileSystemRights.FullControl,FileShare.None,4096,FileOptions.WriteThrough,acl)){file.Write(bytes,0,bytes.Length);file.Flush(true);}Check();
  }
  static string Fresh(string kind,string nonce){string parent=@"C:\EnclaveRpc"+kind+"-"+nonce,root=parent+@"\"+nonce;DirectoryNew(parent);DirectoryNew(root);Write(Path.Combine(root,"QUALIFICATION-ONLY.txt"),Bytes("SYNTHETIC FILE FIXTURE ONLY. NOT A REAL VM, CUT, CAPACITY OR PRODUCTION ADMISSION."));return root;}
  static void PinSelf(string expected){using(var self=Process.GetCurrentProcess()){string path=self.MainModule.FileName;HoldNamespace(Path.GetDirectoryName(path));var handle=ProtectedAttempt.CreateFile(path,0x80020000,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero);if(handle.IsInvalid){handle.Dispose();throw new Win32Exception(Marshal.GetLastWin32Error());}Held.Add(handle);ProtectedAttempt.Authority(handle,true,false,path);var stream=new FileStream(handle,FileAccess.Read);Held.Add(stream);if(stream.Length<1||stream.Length>262144)throw new InvalidOperationException("Fixture image size differs");byte[] bytes=new byte[(int)stream.Length];int offset=0;while(offset<bytes.Length){Check();int n=stream.Read(bytes,offset,bytes.Length-offset);if(n==0)throw new IOException("Short image read");offset+=n;}if(Hash(bytes)!=expected)throw new InvalidOperationException("Fixture image differs");}}
  public static int Main(string[] args){
   try{
    if(args.Length!=10||args[0]!="--target")return 64;
    string boot=args[1],handoffNonce=args[6],vmNonce=args[7],mediaNonce=args[8];Hex(boot,32);Hex(handoffNonce,32);Hex(vmNonce,32);Hex(mediaNonce,32);Hex(args[9],64);
    if(handoffNonce==vmNonce||handoffNonce==mediaNonce||vmNonce==mediaNonce)throw new ArgumentException("Separate fixture namespaces required");
    Origin=Int64.Parse(args[2],NumberStyles.None,CultureInfo.InvariantCulture);Deadline=Int64.Parse(args[3],NumberStyles.None,CultureInfo.InvariantCulture);OriginalOrigin=Int64.Parse(args[4],NumberStyles.None,CultureInfo.InvariantCulture);OriginalDeadline=Int64.Parse(args[5],NumberStyles.None,CultureInfo.InvariantCulture);
    long now=BoundedWorker.MonotonicMilliseconds();if(Origin<0||Origin>Int64.MaxValue-30000||now<Origin||now-Origin>=5000||Deadline<=now||Deadline>Origin+30000||OriginalOrigin<0||OriginalOrigin>Int64.MaxValue-900000||OriginalDeadline!=OriginalOrigin+900000||Origin<OriginalOrigin||Deadline>OriginalDeadline)throw new ArgumentException("Original fixture timing differs");
    Arm();var envelope=BoundedWorker.EnterSupervisorEnvelope(128UL*1024*1024);ProtectedAttempt.RequireAdministrator();if(ProtectedAttempt.CurrentBoot()!=boot)throw new InvalidOperationException("Native boot changed");PinSelf(args[9]);
    var memory=new Memory();memory.Length=(uint)Marshal.SizeOf(typeof(Memory));ulong floor=62709039104UL;
#if FILE_FIXTURE_CI
    if(Environment.GetEnvironmentVariable("GITHUB_ACTIONS")!="true"||Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT")!="github-hosted")throw new InvalidOperationException("Hosted fixture variant only");floor=3UL*1073741824;
#endif
    if(!GlobalMemoryStatusEx(ref memory)||memory.Available<floor)throw new InvalidOperationException("Retained physical/pending floor refused");
    ulong available,total,free;if(!GetDiskFreeSpaceExW(@"C:\",out available,out total,out free)||available<21UL*1073741824+256UL*1048576)throw new InvalidOperationException("Retained disk floor refused");
    string handoff=Fresh("LegacyHandoff",handoffNonce),vm=Fresh("Vm",vmNonce),media=Fresh("PrivateMedia",mediaNonce);
    byte[] contract=Bytes(String.Join("\n",new[]{"owned-rpc-legacy-handoff-v1",handoffNonce,boot,Origin.ToString(CultureInfo.InvariantCulture),Deadline.ToString(CultureInfo.InvariantCulture),new string('a',64),"legacy-memory-cut-seed-v1",new string('b',64),""}));
    var activation=new Dictionary<string,object>{{"schema","legacy-pool-seed/2"},{"creationMode","retained-fenced-rpc-only/1"},{"manifest",new string('b',64)},{"boot",boot},{"configPath",@"C:\Fixture\pool.txt"},{"poolHash",new string('c',64)},{"capacityBytes",79267102720L},{"initialBytes",16154361856L},{"initialCount",4},{"physicalBytes",120070115328L},{"nonPoolReserveBytes",20401094656L},{"floorBytes",19327352832L},{"variationBytes",1073741824L},{"prospectiveBytes",41301311488L},{"cutHash",new string('d',64)},{"inventoryHash",new string('e',64)},{"providerSettled",false},{"capacityAdmitted",false},{"reservationMayRelease",false}};
    byte[] activationRaw=Bytes(Json.Serialize(activation));Write(Path.Combine(handoff,"contract.txt"),contract);Write(Path.Combine(handoff,"pool.activation"),activationRaw);Write(Path.Combine(handoff,"pool.complete"),Bytes(Hash(activationRaw)));
    byte[] dummyBoot=new byte[32768],dummySeed=Bytes("INERT-TARGET-SEED-NO-CREDENTIALS");Write(Path.Combine(media,"boot.vhdx"),dummyBoot);Write(Path.Combine(media,"seed.iso"),dummySeed);
    byte[] plan=Bytes(String.Join("\n",new[]{"owned-rpc-definition/1",vmNonce,boot,new string('f',64),new string('a',64),vm,OriginalOrigin.ToString(CultureInfo.InvariantCulture),OriginalDeadline.ToString(CultureInfo.InvariantCulture),Hash(dummyBoot),Hash(dummySeed),"generation-2-ubuntu;guest=20401094656;support=1073741824;vcpus=4;start=false",""}));
    byte[] receipt=Bytes("{\"fixture\":\"synthetic-off-definition-NOT-A-VM\"}"),definitionSystem=Bytes(Json.Serialize(new{receipt=Hash(receipt),system="Msvm_ComputerSystem.CreationClassName=\"Msvm_ComputerSystem\",Name=\"00000000-0000-0000-0000-000000000001\""}));
    Write(Path.Combine(vm,"definition-plan.txt"),plan);Write(Path.Combine(vm,"definition.receipt"),receipt);Write(Path.Combine(vm,"definition.system"),definitionSystem);Write(Path.Combine(vm,"definition.off"),Bytes(Hash(definitionSystem)+";"+Hash(plan)+";owned-off-zero;start-authorized=false"));Check();
    using(var self=Process.GetCurrentProcess())Console.WriteLine(Json.Serialize(new{success=true,fixtureOnly=true,pid=self.Id,creation=self.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(CultureInfo.InvariantCulture),origin=Origin,deadline=Deadline,envelope=envelope,collect=new{root=handoff,contractHash=Hash(contract),activation=activation},copy=new{sourceRoot=media,planHash=Hash(plan)},vmRoot=vm,dummyFiles=new[]{new{name="boot.vhdx",bytes=dummyBoot.Length,sha256=Hash(dummyBoot)},new{name="seed.iso",bytes=dummySeed.Length,sha256=Hash(dummySeed)}},vmChanged=false}));return 0;
   }catch(Exception error){Console.Error.WriteLine(error.GetType().Name+": "+error.Message);return 1;}finally{foreach(var held in Held)held.Dispose();}
  }
 }
}
