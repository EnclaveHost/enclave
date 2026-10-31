// Fixed Hyper-V start transaction. Library only: no CLI or production activation.
// The caller must supply a protected journal and independently supervised worker.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Management;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace Enclave.OwnedRpc {
    public sealed class StartIdentity {
        public readonly string Attempt,Boot,AdmissionHash,ContractHash,VmGuid,VmName,OwnerNote,ConfigurationRoot;
        public readonly string WorkerImageHash;
        public readonly long Origin,Deadline,WorkerCreation,ObserverCreation;
        public readonly uint WorkerPid,ObserverPid;
        public StartIdentity(string attempt,string boot,string admissionHash,string contractHash,string vmGuid,
            string vmName,string ownerNote,string configurationRoot,long origin,long deadline,uint workerPid,
            long workerCreation,uint observerPid,long observerCreation,string workerImageHash) {
            Hex(attempt,32);Hex(boot,32);Hex(admissionHash,64);Hex(contractHash,64);Hex(workerImageHash,64);
            Guid guid;if(!Guid.TryParseExact(vmGuid,"D",out guid)||guid==Guid.Empty||guid.ToString("D")!=vmGuid)throw new ArgumentException("Canonical VM GUID");
            if(vmName!="enclave-owned-rpc-"+attempt||ownerNote!="owned-rpc/"+attempt+"/"+admissionHash)throw new ArgumentException("Owned VM marker");
            if(configurationRoot==null||configurationRoot.Length>240||configurationRoot.Length<4||configurationRoot[1]!=':'||configurationRoot[2]!='\\'||
                configurationRoot.IndexOfAny(new[]{'"','\r','\n','\0','/'})>=0||configurationRoot.IndexOf(':',2)>=0||
                !String.Equals(Path.GetFullPath(configurationRoot),configurationRoot,StringComparison.OrdinalIgnoreCase))throw new ArgumentException("Canonical configuration root");
            if(origin<0||origin>Int64.MaxValue-900000||deadline!=origin+900000||workerPid==0||observerPid==0||workerPid==observerPid||workerCreation<=0||observerCreation<=0)
                throw new ArgumentException("Original timing/process identity");
            Attempt=attempt;Boot=boot;AdmissionHash=admissionHash;ContractHash=contractHash;VmGuid=vmGuid;VmName=vmName;OwnerNote=ownerNote;ConfigurationRoot=configurationRoot;
            Origin=origin;Deadline=deadline;WorkerPid=workerPid;WorkerCreation=workerCreation;ObserverPid=observerPid;ObserverCreation=observerCreation;WorkerImageHash=workerImageHash;
        }
        internal static void Hex(string text,int length){if(text==null||text.Length!=length||!Regex.IsMatch(text,"\\A[0-9a-f]+\\z"))throw new ArgumentException("Digest encoding");}
        public string Encode(){return StartRecords.Encode(new Dictionary<string,object>{
            {"schema","owned-rpc-start-intent/1"},{"attempt",Attempt},{"boot",Boot},{"admission",AdmissionHash},{"contract",ContractHash},
            {"vmGuid",VmGuid},{"vmName",VmName},{"ownerNote",OwnerNote},{"configurationRoot",ConfigurationRoot},
            {"namespace",@"root\virtualization\v2"},{"class","Msvm_ComputerSystem"},{"method","RequestStateChange"},{"requestedState",2},
            {"origin",Origin},{"deadline",Deadline},{"workerPid",WorkerPid},{"workerCreation",WorkerCreation},{"observerPid",ObserverPid},
            {"observerCreation",ObserverCreation},{"workerImage",WorkerImageHash}});}
    }
    // Exclusive publication must durably consume the name BEFORE returning. A
    // partial pending file stays consumed; implementations must never erase it.
    public interface IStartJournal { void WriteOnce(string name,string value); string Read(string name); }
    // Null Read means definitely absent. Inaccessible/partial/malformed is an
    // exception, never absence. Existing ProtectedAttempt supplies held ACL/file
    // identity validation; this adapter supplies STORAGE, not VM authority.
    public sealed class ProtectedStartJournal : IStartJournal {
        readonly ProtectedAttempt pin;
        public ProtectedStartJournal(ProtectedAttempt pin){if(pin==null)throw new ArgumentNullException("pin");this.pin=pin;}
        public void WriteOnce(string name,string value){StartRecords.Name(name);pin.WriteOnce(name,value);}
        public string Read(string name){
            StartRecords.Name(name);
            string value=pin.ReadOptionalOnce(name);if(value!=null)return value;
            // A failed publication remains ambiguous, including an empty file.
            if(pin.ReadOptionalOnce(name+".pending")!=null)throw new IOException("Unpublished journal record");
            return null;
        }
    }
    public interface IStartRuntime {
        long Now {get;}
        // Must check live exact observer/worker binding, boot, original admission,
        // closed one-shot gate and original owned VM before the fixed invocation.
        void VerifyBeforeSubmit(StartIdentity identity);
        // Separate bounded read authority may outlive startup, but cannot submit.
        // Verify its original read-worker deadline/boot/identity before AND after IO.
        void VerifyObservation(StartIdentity identity);
    }
    public sealed class StartResponse {
        public readonly uint ReturnCode;public readonly string JobReference;
        public StartResponse(uint code,string reference){ReturnCode=code;JobReference=reference;}
    }
    public sealed class StartJob {
        public readonly string Reference,InstanceId,TimeSubmitted;
        public readonly ushort State,ErrorCode;public readonly uint RunTimes;
        public StartJob(string reference,string id,string submitted,ushort state,ushort error,uint runs){
            Reference=reference;InstanceId=id;TimeSubmitted=submitted;State=state;ErrorCode=error;RunTimes=runs;
        }
    }
    public interface IStartProvider {StartResponse Start(StartIdentity identity);StartJob ReadJob(string exactReference);}
    public sealed class StartOutcome {
        public readonly string State;public readonly bool OperationSettled,OperationSucceeded;
        public bool ProviderOperationFenced {get{return false;}}
        public bool ReservationMayRelease {get{return false;}}
        internal StartOutcome(string state,bool settled,bool succeeded){State=state;OperationSettled=settled;OperationSucceeded=succeeded;}
    }
    internal static class StartRecords {
        static JavaScriptSerializer Json(){return new JavaScriptSerializer{MaxJsonLength=4096,RecursionLimit=4};}
        internal static string Encode(Dictionary<string,object> value){string s=Json().Serialize(value);if(Encoding.UTF8.GetByteCount(s)>4096)throw new ArgumentException("Record bound");return s;}
        internal static Dictionary<string,object> Parse(string value,string[] keys){
            if(value==null||Encoding.UTF8.GetByteCount(value)>4096)throw new InvalidOperationException("Record missing or oversized");
            var d=Json().DeserializeObject(value) as Dictionary<string,object>;if(d==null||d.Count!=keys.Length)throw new InvalidOperationException("Record shape");
            foreach(string key in keys)if(!d.ContainsKey(key))throw new InvalidOperationException("Record field missing");return d;
        }
        internal static string Text(object v){var s=v as string;if(s==null||s.Length>2048)throw new InvalidOperationException("Record string");return s;}
        internal static long Number(object v){if(!(v is int)&&!(v is long))throw new InvalidOperationException("Record integer");return Convert.ToInt64(v,CultureInfo.InvariantCulture);}
        internal static void Name(string n){if(n!="start.intent"&&n!="start.submit"&&n!="start.native"&&n!="start.receipt"&&n!="start.job"&&n!="start.terminal")throw new ArgumentException("Fixed record name");}
    }
    public static class ProviderStart {
        static string Hash(string s){return ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(s));}
        static void Current(StartIdentity id,IStartRuntime runtime){long now=runtime.Now;if(now<id.Origin||now>=id.Deadline)throw new InvalidOperationException("Original start deadline/clock");}
        static string Intent(StartIdentity id,IStartJournal journal){string raw=id.Encode();if(journal.Read("start.intent")!=raw)throw new InvalidOperationException("Exact consumed start intent required");return Hash(raw);}
        // Called by the owner while the exact child is held suspended, before its
        // one-shot work gate. There is deliberately no prepare-if-missing in Submit.
        public static void Prepare(StartIdentity id,IStartJournal journal){journal.WriteOnce("start.intent",id.Encode());}
        public static StartOutcome Submit(StartIdentity id,IStartJournal journal,IStartProvider provider,IStartRuntime runtime){
            string intent=Intent(id,journal);Current(id,runtime);
            // This exclusive durable record is the only submission entitlement.
            // Another process/restart cannot acquire it even after a lost response.
            journal.WriteOnce("start.submit",intent);
            runtime.VerifyBeforeSubmit(id);Current(id,runtime);
            StartResponse response=provider.Start(id); // exactly ONE call; exceptions stay consumed
            if(response==null)throw new InvalidOperationException("Lost native response");
            string reference="";
            if(response.ReturnCode==4096)reference=HyperVStartProvider.CanonicalJobReference(response.JobReference);
            else if(!String.IsNullOrEmpty(response.JobReference))throw new InvalidOperationException("Unexpected response reference");
            // Persist the exact validated returned reference BEFORE any provider
            // follow-up read or acknowledgement to the caller.
            journal.WriteOnce("start.receipt",StartRecords.Encode(new Dictionary<string,object>{{"intent",intent},{"code",response.ReturnCode},{"job",reference}}));
            return Reconcile(id,journal,provider,runtime);
        }
        public static StartOutcome Reconcile(StartIdentity id,IStartJournal journal,IStartProvider provider,IStartRuntime runtime){
            string intent=Intent(id,journal);
            if(journal.Read("start.submit")!=intent)return new StartOutcome("submission-not-proven",false,false);
            string raw=journal.Read("start.receipt");if(raw==null)return new StartOutcome("response-lost-held",false,false);
            var receipt=StartRecords.Parse(raw,new[]{"intent","code","job"});
            if(StartRecords.Text(receipt["intent"])!=intent)throw new InvalidOperationException("Receipt intent differs");
            long code=StartRecords.Number(receipt["code"]);string reference=StartRecords.Text(receipt["job"]);
            if(code<0||code>UInt32.MaxValue)throw new InvalidOperationException("Return code range");
            if(code==0){if(reference!="")throw new InvalidOperationException("Synchronous reference");return new StartOutcome("synchronous-complete",true,true);}
            if(code!=4096){if(reference!="")throw new InvalidOperationException("Refusal reference");return new StartOutcome("provider-return-"+code+"-held",false,false);}
            if(HyperVStartProvider.CanonicalJobReference(reference)!=reference)throw new InvalidOperationException("Noncanonical receipt job");
            string terminal=journal.Read("start.terminal");
            if(terminal!=null){
                var t=StartRecords.Parse(terminal,new[]{"receipt","identity","state","error","runs"});
                string identity=journal.Read("start.job");if(identity==null||StartRecords.Text(t["receipt"])!=Hash(raw)||StartRecords.Text(t["identity"])!=Hash(identity)||StartRecords.Number(t["state"])!=7||StartRecords.Number(t["runs"])!=1)
                    throw new InvalidOperationException("Terminal receipt binding");
                long error=StartRecords.Number(t["error"]);if(error<0||error>UInt16.MaxValue)throw new InvalidOperationException("Terminal error range");
                return new StartOutcome("job-completed",true,error==0);
            }
            // Only live observation needs the current worker/boot/admission check.
            // A protected complete receipt survives provider garbage collection.
            runtime.VerifyObservation(id);
            StartJob job=provider.ReadJob(reference);runtime.VerifyObservation(id);
            if(job==null||job.Reference!=reference||HyperVStartProvider.ReferenceForId(job.InstanceId)!=reference||String.IsNullOrEmpty(job.TimeSubmitted)||job.TimeSubmitted.Length>32)
                throw new InvalidOperationException("Returned job identity unavailable");
            string expected=StartRecords.Encode(new Dictionary<string,object>{{"receipt",Hash(raw)},{"job",reference},{"submitted",job.TimeSubmitted}});
            string recorded=journal.Read("start.job");
            if(recorded==null){journal.WriteOnce("start.job",expected);recorded=expected;}
            if(recorded!=expected)throw new InvalidOperationException("Provider job incarnation changed");
            // Suspended/service/abnormal/killed are NOT proof of no later work.
            // Only nonrecurring Completed has an admitted settlement meaning.
            if(job.State!=7||job.RunTimes!=1)return new StartOutcome("job-state-"+job.State+"-held",false,false);
            journal.WriteOnce("start.terminal",StartRecords.Encode(new Dictionary<string,object>{{"receipt",Hash(raw)},{"identity",Hash(recorded)},{"state",7},{"error",job.ErrorCode},{"runs",job.RunTimes}}));
            return new StartOutcome("job-completed",true,job.ErrorCode==0);
        }
    }
    // Fixed local provider implementation, with no arbitrary method/path dispatch.
    // This library has no entry point and is not reachable from InertEntry.
    public sealed class HyperVStartProvider : IStartProvider {
        const string Namespace=@"root\virtualization\v2";
        readonly IStartRuntime runtime;readonly IStartJournal journal;
        public HyperVStartProvider(IStartRuntime runtime,IStartJournal journal){if(runtime==null||journal==null)throw new ArgumentNullException("dependencies");this.runtime=runtime;this.journal=journal;}
        public static string ReferenceForId(string id){if(id==null||!Regex.IsMatch(id,"\\A[A-Za-z0-9_:{}.\\-]{1,128}\\z"))throw new InvalidOperationException("Job key encoding");return "Msvm_ConcreteJob.InstanceID=\""+id+"\"";}
        public static string CanonicalJobReference(string raw){
            if(raw==null||raw.Length>2048)throw new InvalidOperationException("Returned job reference bound");
            var path=new ManagementPath(raw);
            if(!path.IsInstance||!String.Equals(path.ClassName,"Msvm_ConcreteJob",StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Returned job class");
            if(path.Server!=""&&path.Server!="."&&!String.Equals(path.Server,Environment.MachineName,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Remote provider refused");
            string ns=path.NamespacePath;
            if(ns.StartsWith(@"\\")){int slash=ns.IndexOf('\\',2);if(slash<0)throw new InvalidOperationException("Provider namespace");ns=ns.Substring(slash+1);}
            if(ns!=""&&!String.Equals(ns,Namespace,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Provider namespace");
            var m=Regex.Match(path.RelativePath,"\\AMsvm_ConcreteJob\\.InstanceID=\"([A-Za-z0-9_:{}.\\-]{1,128})\"\\z",RegexOptions.IgnoreCase);
            if(!m.Success)throw new InvalidOperationException("Exact single job key required");return ReferenceForId(m.Groups[1].Value);
        }
        static ManagementScope Scope(){return new ManagementScope(@"\\.\"+Namespace,new ConnectionOptions{EnablePrivileges=true,Timeout=TimeSpan.FromSeconds(2)});}
        static ManagementObject One(ManagementScope scope,string query){
            var options=new EnumerationOptions{ReturnImmediately=false,Rewindable=false,Timeout=TimeSpan.FromSeconds(2)};ManagementObject found=null;
            try{using(var search=new ManagementObjectSearcher(scope,new ObjectQuery(query),options))using(var rows=search.Get())foreach(ManagementObject row in rows){if(found!=null){row.Dispose();throw new InvalidOperationException("Exact singleton required");}found=row;}
                if(found==null)throw new InvalidOperationException("Exact provider object absent");return found;
            }catch{if(found!=null)found.Dispose();throw;}
        }
        public StartResponse Start(StartIdentity id){
            ProtectedAttempt.RequireSystem();runtime.VerifyBeforeSubmit(id);
            string intent=id.Encode(),digest=ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(intent));
            if(journal.Read("start.intent")!=intent||journal.Read("start.submit")!=digest)throw new InvalidOperationException("Native invocation lacks consumed intent");
            journal.WriteOnce("start.native",digest); // native adapter itself is one-shot too
            var scope=Scope();
            using(var vm=One(scope,"SELECT * FROM Msvm_ComputerSystem WHERE Name='"+id.VmGuid+"'"))
            using(var settings=One(scope,"SELECT * FROM Msvm_VirtualSystemSettingData WHERE VirtualSystemIdentifier='"+id.VmGuid+"' AND VirtualSystemType='Microsoft:Hyper-V:System:Realized'")){
                var notes=settings["Notes"] as string[];
                if((string)vm["Name"]!=id.VmGuid||(string)vm["ElementName"]!=id.VmName||Convert.ToUInt16(vm["EnabledState"])!=3||
                    (string)settings["VirtualSystemIdentifier"]!=id.VmGuid||(string)settings["ElementName"]!=id.VmName||notes==null||notes.Length!=1||notes[0]!=id.OwnerNote||
                    !String.Equals((string)settings["ConfigurationDataRoot"],id.ConfigurationRoot,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Original owned Off VM differs");
                using(var input=vm.GetMethodParameters("RequestStateChange")){
                    input["RequestedState"]=(ushort)2;
                    runtime.VerifyBeforeSubmit(id);long now=runtime.Now;if(now<id.Origin||now>=id.Deadline)throw new InvalidOperationException("Original deadline expired");
                    using(var output=vm.InvokeMethod("RequestStateChange",input,new InvokeMethodOptions{Timeout=TimeSpan.FromSeconds(2)})){
                        if(output==null||output["ReturnValue"]==null)throw new InvalidOperationException("No native response");
                        return new StartResponse(Convert.ToUInt32(output["ReturnValue"]),output["Job"] as string);
                    }
                }
            }
        }
        public StartJob ReadJob(string reference){
            ProtectedAttempt.RequireSystem();string path=CanonicalJobReference(reference);if(path!=reference)throw new InvalidOperationException("Persisted canonical reference required");
            using(var job=new ManagementObject(Scope(),new ManagementPath(path),new ObjectGetOptions{Timeout=TimeSpan.FromSeconds(2)})){
                job.Get();if(CanonicalJobReference(job.Path.Path)!=reference)throw new InvalidOperationException("Provider reference changed");
                foreach(string field in new[]{"InstanceID","TimeSubmitted","JobState","ErrorCode","JobRunTimes"})if(job[field]==null)throw new InvalidOperationException("Job field absent");
                string time=(string)job["TimeSubmitted"];ManagementDateTimeConverter.ToDateTime(time);
                return new StartJob(reference,(string)job["InstanceID"],time,Convert.ToUInt16(job["JobState"]),Convert.ToUInt16(job["ErrorCode"]),Convert.ToUInt32(job["JobRunTimes"]));
            }
        }
    }
}
