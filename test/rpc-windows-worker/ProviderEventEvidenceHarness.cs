using System;
using System.Collections.Generic;
using System.Threading;
using Enclave.OwnedRpc;

public static class ProviderEventEvidenceHarness {
 static int tests;
 static void Check(bool ok){if(!ok)throw new Exception("Assertion");}
 static void Test(string name,Action run){run();tests++;Console.WriteLine("PASS "+name);}
 static void Refuse(Action run){bool refused=false;try{run();}catch{refused=true;}Check(refused);}
 static EventEvidenceSelection Select(){return new EventEvidenceSelection(new string('a',32),new string('b',32),new string('c',32),17,1000000000,1010000000,1020000000);}
 sealed class Fake:IProviderEventSource {
  internal Action<ProviderEventChannel> Change;
  public ProviderEventChannel Read(string channel,EventEvidenceSelection selection,Action check){
   var result=new ProviderEventChannel{Channel=channel,State="query-ended",Enabled=true,RecordCount=1,OldestRecord=1};
   result.Records.Add(new ProviderEventRow{RecordId=1,EventId=5858,TimeFileTime=1005000000,ProcessId=17,Xml="<Event><Data>fixture</Data></Event>"});
   if(Change!=null)Change(result);return result;
  }
 }
 static string Read(Fake f){return ProviderEventEvidence.Collect(Select(),f,()=>{});}
 public static int Main(string[] args){
  ClockSample.Arm(BoundedWorker.MonotonicMilliseconds());BoundedWorker.EnterSupervisorEnvelope(128UL*1024*1024);
  if(args.Length==1&&args[0]=="blocked-main"){Console.WriteLine("watchdog-armed");Thread.Sleep(Timeout.Infinite);return 99;}
  try{
   Test("fixed-two-channel-query-and-nonsettling-output",()=>{string text=Read(new Fake());Check(ProviderEventEvidence.Channels.Length==2&&text.Contains("\"providerSettled\":false")&&text.Contains("\"absenceProvesNothing\":true")&&text.Contains("\"clientPid\":17"));});
   Test("historical-range-only-no-caller-query",()=>{string query=Select().Query;Check(query.StartsWith("*[System[TimeCreated[")&&query.Contains("1601-")&&!query.Contains("17"));});
   Test("bad-identity-and-pid-refused",()=>{var s=Select();Refuse(()=>new EventEvidenceSelection("X",s.VmAttempt,s.Boot,17,s.Created,s.End,s.End));Refuse(()=>new EventEvidenceSelection(s.Nonce,s.VmAttempt,s.Boot,0,s.Created,s.End,s.End));});
   Test("future-reversed-overlong-window-refused",()=>{var s=Select();foreach(long end in new[]{s.Created,s.Created-1,s.Created+600000001})Refuse(()=>new EventEvidenceSelection(s.Nonce,s.VmAttempt,s.Boot,17,s.Created,end,Int64.MaxValue));Refuse(()=>new EventEvidenceSelection(s.Nonce,s.VmAttempt,s.Boot,17,s.Created,s.End,s.End-1));});
   Test("sixty-second-boundary-accepted",()=>{var s=Select();new EventEvidenceSelection(s.Nonce,s.VmAttempt,s.Boot,17,s.Created,s.Created+600000000,s.Created+600000000);});
   Test("foreign-channel-refused",()=>Refuse(()=>Read(new Fake{Change=x=>x.Channel="Security"})));
   Test("wrong-time-and-duplicate-record-refused",()=>{Refuse(()=>Read(new Fake{Change=x=>x.Records[0].TimeFileTime=Select().End+1}));Refuse(()=>Read(new Fake{Change=x=>x.Records.Add(x.Records[0])}));});
   Test("unavailable-not-reported-as-empty-success",()=>{string text=Read(new Fake{Change=x=>{x.State="unavailable";x.ErrorType="EventLogNotFoundException";x.Records.Clear();}});Check(text.Contains("unavailable")&&text.Contains("\"providerSettled\":false"));Refuse(()=>Read(new Fake{Change=x=>x.State="unavailable"}));});
   Test("unknown-status-refused",()=>Refuse(()=>Read(new Fake{Change=x=>x.State="settled"})));
   Test("row-cap-refused",()=>Refuse(()=>Read(new Fake{Change=x=>{for(int i=2;i<=25;i++)x.Records.Add(new ProviderEventRow{RecordId=i,TimeFileTime=1005000000,Xml="x"});}})));
   Test("utf8-and-aggregate-output-bounds",()=>{Refuse(()=>Read(new Fake{Change=x=>x.Records[0].Xml=new string('\u754c',6000)}));Refuse(()=>Read(new Fake{Change=x=>{x.Records[0].Xml=new string('x',12000);x.Records.Add(new ProviderEventRow{RecordId=2,TimeFileTime=1005000000,Xml=new string('x',6000)});}}));});
   Test("deadline-callback-propagates",()=>{int calls=0;Refuse(()=>ProviderEventEvidence.Collect(Select(),new Fake(),()=>{if(++calls==3)throw new TimeoutException();}));Check(calls==3);});
   Console.WriteLine("RESULT tests="+tests+" fixtureEvents=true providerCalls=false");return 0;
  }catch(Exception e){Console.Error.WriteLine(e.GetType().Name+": "+e.Message);return 1;}
 }
}
