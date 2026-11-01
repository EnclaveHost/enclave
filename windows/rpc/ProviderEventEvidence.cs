// Read-only historical evidence. An empty/incomplete log never settles a provider operation.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.Globalization;
using System.IO;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;

namespace Enclave.OwnedRpc {
 internal sealed class EventEvidenceSelection {
  internal readonly string Nonce,VmAttempt,Boot;
  internal readonly int ClientPid;
  internal readonly long Created,End;
  internal EventEvidenceSelection(string nonce,string vm,string boot,int pid,long created,long end,long now){
   foreach(string value in new[]{nonce,vm,boot}){if(value==null||value.Length!=32)throw new ArgumentException("Evidence identity length");foreach(char c in value)if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))throw new ArgumentException("Evidence identity encoding");}
   if(pid<=0||created<=0||end<=created||end-created>600000000||end>now)throw new ArgumentException("Historical window must be positive, past and at most sixty seconds");
   DateTime.FromFileTimeUtc(created);DateTime.FromFileTimeUtc(end);
   Nonce=nonce;VmAttempt=vm;Boot=boot;ClientPid=pid;Created=created;End=end;
  }
  internal string Query {get{return "*[System[TimeCreated[@SystemTime >= '"+DateTime.FromFileTimeUtc(Created).ToString("o",CultureInfo.InvariantCulture)+"' and @SystemTime <= '"+DateTime.FromFileTimeUtc(End).ToString("o",CultureInfo.InvariantCulture)+"']]]";}}
 }
 internal sealed class ProviderEventRow {
  public long RecordId,TimeFileTime;
  public int EventId;
  public int? ProcessId;
  public string ActivityId,Xml;
 }
 internal sealed class ProviderEventChannel {
  public string Channel,State,ErrorType;
  public int ErrorHResult;
  public bool? Enabled;
  public long? RecordCount,OldestRecord;
  public List<ProviderEventRow> Records=new List<ProviderEventRow>();
 }
 internal interface IProviderEventSource { ProviderEventChannel Read(string channel,EventEvidenceSelection selection,Action check); }
 internal static class ProviderEventEvidence {
  internal static readonly string[] Channels={"Microsoft-Windows-WMI-Activity/Operational","Microsoft-Windows-Hyper-V-VMMS/Admin","Microsoft-Windows-Hyper-V-VMMS/Operational"};
  internal static string Collect(EventEvidenceSelection selection,IProviderEventSource source,Action check){
   if(selection==null||source==null||check==null)throw new ArgumentNullException("Evidence dependencies");
   var rows=new List<ProviderEventChannel>();long xmlBytes=0;
   foreach(string channel in Channels){
    check();var result=source.Read(channel,selection,check);check();
    if(result==null||result.Channel!=channel||result.Records==null||result.Records.Count>24||
       (result.State!="query-ended"&&result.State!="unavailable"))throw new InvalidOperationException("Evidence channel or bound differs");
    if(result.State=="unavailable"&&(result.Records.Count!=0||String.IsNullOrEmpty(result.ErrorType)))throw new InvalidOperationException("Incomplete channel shape");
    var ids=new HashSet<long>();
    foreach(var row in result.Records){
     if(row==null||row.RecordId<=0||!ids.Add(row.RecordId)||row.TimeFileTime<selection.Created||row.TimeFileTime>selection.End||row.Xml==null||row.Xml.Length>16384||row.ActivityId!=null&&row.ActivityId.Length>64)throw new InvalidOperationException("Evidence row binding or bound differs");
     int bytes=Encoding.UTF8.GetByteCount(row.Xml);xmlBytes+=bytes;if(bytes>16384||xmlBytes>32768)throw new InvalidOperationException("Evidence XML byte bound");check();
    }
    rows.Add(result);
   }
   var json=new JavaScriptSerializer{MaxJsonLength=65536,RecursionLimit=12};
   string text=json.Serialize(new{schema="owned-rpc-provider-event-evidence/1",nonce=selection.Nonce,vmAttempt=selection.VmAttempt,boot=selection.Boot,clientPid=selection.ClientPid,clientCreationFileTime=selection.Created,endFileTime=selection.End,channels=rows,readOnly=true,providerSettled=false,reservationMayRelease=false,absenceProvesNothing=true});
   if(Encoding.UTF8.GetByteCount(text)>49152)throw new InvalidOperationException("Evidence serialized byte bound");check();return text;
  }
 }
 internal sealed class NativeProviderEventSource:IProviderEventSource {
  public ProviderEventChannel Read(string channel,EventEvidenceSelection selection,Action check){
   if(Array.IndexOf(ProviderEventEvidence.Channels,channel)<0)throw new ArgumentException("Fixed provider channel required");
   check();var result=new ProviderEventChannel{Channel=channel,State="query-ended"};
   try{
    using(var config=new EventLogConfiguration(channel)){result.Enabled=config.IsEnabled;}
    var info=EventLogSession.GlobalSession.GetLogInformation(channel,PathType.LogName);result.RecordCount=info.RecordCount;result.OldestRecord=info.OldestRecordNumber;check();
    var query=new EventLogQuery(channel,PathType.LogName,selection.Query){ReverseDirection=false,TolerateQueryErrors=false};
    using(var reader=new EventLogReader(query)){reader.BatchSize=1;
     while(true){check();using(var record=reader.ReadEvent(TimeSpan.FromMilliseconds(250))){
      check();if(record==null)break;if(result.Records.Count>=24)throw new InvalidOperationException("Provider event row bound");
      if(record.LogName!=channel||!record.RecordId.HasValue||!record.TimeCreated.HasValue)throw new InvalidOperationException("Provider event identity absent");
      string xml=record.ToXml();if(xml==null||Encoding.UTF8.GetByteCount(xml)>16384)throw new InvalidOperationException("Provider event XML bound");
      result.Records.Add(new ProviderEventRow{RecordId=record.RecordId.Value,EventId=record.Id,TimeFileTime=record.TimeCreated.Value.ToUniversalTime().ToFileTimeUtc(),ProcessId=record.ProcessId,ActivityId=record.ActivityId.HasValue?record.ActivityId.Value.ToString("D"):null,Xml=xml});
     }}
    }
   }catch(EventLogException error){
    // Partial/error reads cannot masquerade as an empty successfully read log.
    if(result.Records.Count!=0)throw;
    result.State="unavailable";result.ErrorType=error.GetType().Name;result.ErrorHResult=error.HResult;
   }
   check();return result;
  }
 }
 public static class ProviderEventEvidenceEntry {
  static void Image(string expected){
   if(expected==null||expected.Length!=64)throw new ArgumentException("Image digest length");
   using(var self=Process.GetCurrentProcess())using(var file=new FileStream(self.MainModule.FileName,FileMode.Open,FileAccess.Read,FileShare.Read)){
    if(file.Length<1||file.Length>262144)throw new InvalidOperationException("Evidence image bound");
    byte[] bytes=new byte[(int)file.Length];int offset=0;while(offset<bytes.Length){int n=file.Read(bytes,offset,bytes.Length-offset);if(n==0)throw new IOException("Short image");offset+=n;}
    if(file.ReadByte()!=-1||ProtectedAttempt.Hash(bytes)!=expected)throw new InvalidOperationException("Evidence image pin differs");
   }
  }
  public static int Main(string[] args){
   long origin=BoundedWorker.MonotonicMilliseconds();
   try{
    ClockSample.Arm(origin);var envelope=BoundedWorker.EnterSupervisorEnvelope(128UL*1024*1024);
    if(!envelope.MembershipVerified||!envelope.LimitsVerified)throw new InvalidOperationException("Evidence envelope differs");
    if(args.Length!=7)return 64;
    using(var identity=WindowsIdentity.GetCurrent())if(identity.ImpersonationLevel!=TokenImpersonationLevel.None||!new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))throw new InvalidOperationException("Primary administrator required for historical log read");
    Image(args[6]);var selected=new EventEvidenceSelection(args[0],args[1],args[2],Int32.Parse(args[3],NumberStyles.None,CultureInfo.InvariantCulture),Int64.Parse(args[4],NumberStyles.None,CultureInfo.InvariantCulture),Int64.Parse(args[5],NumberStyles.None,CultureInfo.InvariantCulture),DateTime.UtcNow.ToFileTimeUtc());
    Action check=()=>{if(BoundedWorker.MonotonicMilliseconds()>=origin+5000)throw new TimeoutException("Original evidence deadline");};
    check();if(ProtectedAttempt.CurrentBoot()!=selected.Boot)throw new InvalidOperationException("Evidence boot differs");
    var json=new JavaScriptSerializer();
    // Publish exact own identity before any log API can block. Not a death receipt.
    Console.WriteLine(json.Serialize(new{schema="owned-rpc-event-reader-entered/1",nonce=selected.Nonce,origin=origin,deadline=origin+5000,pid=envelope.ProcessId,creationFileTime=envelope.CreationFileTime,jobCommitLimitBytes=envelope.JobCommitLimitBytes,bootstrapPrivateBytes=envelope.BootstrapPrivateBytes,coversPreAssignmentMemory=false}));Console.Out.Flush();
    string result=ProviderEventEvidence.Collect(selected,new NativeProviderEventSource(),check);check();Console.WriteLine(result);return 0;
   }catch(Exception error){Console.Error.WriteLine(error.GetType().Name);return 1;}
  }
 }
}
