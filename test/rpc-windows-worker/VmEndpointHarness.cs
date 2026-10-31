// Inert selector/lineage fixtures and independent deadline only. No WMI/VM IO.
using System;
using System.Threading;
using Enclave.OwnedRpc;
public static class VmEndpointHarness {
 static int count;
 static void Check(bool value){if(!value)throw new Exception("Endpoint assertion failed");}
 static void Refuse(Action a){bool refused=false;try{a();}catch{refused=true;}Check(refused);}
 static void Test(string name,Action a){a();count++;Console.WriteLine("PASS endpoint-"+name);}
 public static int Main(string[] args){
  if(args.Length==1&&args[0]=="blocked-main"){
   long now=BoundedWorker.MonotonicMilliseconds();VmEndpoint.Arm(now,now+1000);
   var envelope=BoundedWorker.EnterSupervisorEnvelope(128UL*1048576);
   Check(envelope.MembershipVerified&&envelope.LimitsVerified);Console.WriteLine("watchdog-armed");Thread.Sleep(Timeout.Infinite);return 99;
  }
  if(args.Length!=0)return 64;
  var e=BoundedWorker.EnterSupervisorEnvelope(128UL*1048576);Check(e.MembershipVerified&&e.LimitsVerified);
  Test("one-ipv4",()=>Check(VmEndpoint.Select(new[]{"192.168.8.42"})=="192.168.8.42"));
  Test("mixed-family",()=>Check(VmEndpoint.Select(new[]{"fe80::1","192.168.8.42"})=="192.168.8.42"));
  Test("empty-is-pending",()=>Check(VmEndpoint.Select(new string[0])==null));
  Test("nonroutable-is-pending",()=>Check(VmEndpoint.Select(new[]{"127.0.0.1","169.254.1.2","0.0.0.0","224.1.2.3","255.255.255.255"})==null));
  Test("multiple-ipv4-refused",()=>Refuse(()=>VmEndpoint.Select(new[]{"192.168.8.42","192.168.8.43"})));
  Test("duplicate-refused",()=>Refuse(()=>VmEndpoint.Select(new[]{"192.168.8.42","192.168.8.42"})));
  Test("malformed-refused",()=>{foreach(string s in new[]{"999.1.1.1","10.1","010.0.0.1","192.168.8.42;calc",""})Refuse(()=>VmEndpoint.Select(new[]{s}));});
  Test("null-array-refused",()=>Refuse(()=>VmEndpoint.Select(null)));
  Test("null-element-refused",()=>Refuse(()=>VmEndpoint.Select(new string[]{null})));
  Test("oversized-array-refused",()=>Refuse(()=>VmEndpoint.Select(new string[17])));
  Test("signed-extreme-lease-refused",()=>{Refuse(()=>VmEndpoint.Arm(Int64.MinValue,Int64.MaxValue));Refuse(()=>VmEndpoint.Arm(Int64.MaxValue,Int64.MaxValue));});
  Test("stale-entry-refused",()=>{long now=BoundedWorker.MonotonicMilliseconds();Refuse(()=>VmEndpoint.Arm(now-5000,now+1000));});
  Test("pending-floor-retained",()=>Check(VmEndpoint.MinimumFree==(18432L+39388L+256L)*1048576L));
  int boot=OwnedVmBootHarness.Run();Console.WriteLine("RESULT endpoint="+count+" boot="+boot+" providerCalls=false vmChanged=false targetQualified=false");return 0;
 }
}
