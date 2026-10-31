// Immutable owned-VM authority plus independently leased journal access.
// Library only. No VM creation, provider invocation, scheduler or activation.
using System;
using System.Globalization;
using System.IO;
using System.Security.Principal;
using System.Text;

namespace Enclave.OwnedRpc {
    public sealed class OwnedVmPermit {
        public readonly string Attempt,Boot,AdmissionHash,ImageHash,VmGuid,ConfigurationRoot;
        public readonly long Origin,Deadline,GuestBytes,SupportBytes;
        public string VmName {get{return "enclave-owned-rpc-"+Attempt;}}
        public string OwnerNote {get{return "owned-rpc/"+Attempt+"/"+AdmissionHash;}}
        public long TotalBytes {get{return checked(GuestBytes+SupportBytes);}}
        public OwnedVmPermit(string attempt,string boot,string admission,string image,string guid,string configurationRoot,
            long origin,long deadline,long guestBytes,long supportBytes) {
            StartIdentity.Hex(attempt,32);StartIdentity.Hex(boot,32);StartIdentity.Hex(admission,64);StartIdentity.Hex(image,64);
            Guid g;if(!Guid.TryParseExact(guid,"D",out g)||g==Guid.Empty||g.ToString("D")!=guid)throw new ArgumentException("Exact VM GUID");
            if(origin<0||origin>Int64.MaxValue-900000||deadline!=origin+900000)throw new ArgumentException("Original 900-second permit");
            // This proposed configuration must be replaced explicitly to change
            // its resource budget. These numbers are not evidence of host fit.
            if(guestBytes!=19L*1024*1024*1024 || supportBytes!=1024L*1024*1024)
                throw new ArgumentException("Reviewed 20 GiB whole-stack proposal required");
            if(configurationRoot==null||configurationRoot.Length<4||configurationRoot.Length>240||
                !Char.IsLetter(configurationRoot[0])||configurationRoot[1]!=':'||configurationRoot[2]!='\\'||
                configurationRoot.IndexOfAny(new[]{'"','\r','\n','\0','/'})>=0||configurationRoot.IndexOf(':',2)>=0||
                !String.Equals(Path.GetFullPath(configurationRoot),configurationRoot,StringComparison.OrdinalIgnoreCase))throw new ArgumentException("Local configuration path");
            foreach(string part in configurationRoot.Substring(3).Split('\\'))
                if(part.Length==0||part.EndsWith(".")||part.EndsWith(" "))throw new ArgumentException("Ambiguous configuration path");
            Attempt=attempt;Boot=boot;AdmissionHash=admission;ImageHash=image;VmGuid=guid;ConfigurationRoot=configurationRoot;
            Origin=origin;Deadline=deadline;GuestBytes=guestBytes;SupportBytes=supportBytes;
        }
        public string Encode() {
            return String.Join("\n",new[]{"owned-rpc-vm-permit-v1",Attempt,Boot,AdmissionHash,ImageHash,VmGuid,ConfigurationRoot,
                Origin.ToString(CultureInfo.InvariantCulture),Deadline.ToString(CultureInfo.InvariantCulture),
                GuestBytes.ToString(CultureInfo.InvariantCulture),SupportBytes.ToString(CultureInfo.InvariantCulture),"fixed-local-start-and-reconcile-v1",""});
        }
        public static OwnedVmPermit Parse(string raw) {
            if(raw==null||Encoding.UTF8.GetByteCount(raw)>2048)throw new ArgumentException("Permit bound");
            string[] f=raw.Split('\n');
            if(f.Length!=13||f[0]!="owned-rpc-vm-permit-v1"||f[11]!="fixed-local-start-and-reconcile-v1"||f[12]!="")throw new ArgumentException("Exact VM permit schema");
            var p=new OwnedVmPermit(f[1],f[2],f[3],f[4],f[5],f[6],
                Int64.Parse(f[7],NumberStyles.None,CultureInfo.InvariantCulture),Int64.Parse(f[8],NumberStyles.None,CultureInfo.InvariantCulture),
                Int64.Parse(f[9],NumberStyles.None,CultureInfo.InvariantCulture),Int64.Parse(f[10],NumberStyles.None,CultureInfo.InvariantCulture));
            if(p.Encode()!=raw)throw new ArgumentException("Noncanonical VM permit");return p;
        }
        public void Bind(StartIdentity id,string permitHash) {
            if(id==null||id.Attempt!=Attempt||id.Boot!=Boot||id.AdmissionHash!=AdmissionHash||id.ContractHash!=permitHash||
                id.WorkerImageHash!=ImageHash||id.VmGuid!=VmGuid||id.VmName!=VmName||id.OwnerNote!=OwnerNote||
                id.ConfigurationRoot!=ConfigurationRoot||id.Origin!=Origin||id.Deadline!=Deadline)
                throw new InvalidOperationException("Start intent differs from immutable VM permit");
        }
        internal void ValidateAccess(long now,bool reconcile) {
            if(now<Origin||(!reconcile&&now>=Deadline))throw new InvalidOperationException("Original VM start timing refused");
        }
    }
    // Production journal composition requires both the held immutable permit and
    // the original intent. A later read worker retains the original submitter
    // identities; it does not rewrite them as its own or acquire another start.
    public sealed class OwnedVmStartJournal : IStartJournal {
        readonly ProtectedAttempt pin;readonly StartIdentity identity;readonly ProtectedStartJournal storage;
        public OwnedVmStartJournal(ProtectedAttempt pin,StartIdentity identity) {
            if(pin==null||pin.VmPermit==null)throw new ArgumentException("Held VM permit required");
            pin.CheckDeadline();pin.VmPermit.Bind(identity,pin.ContractHash);
            this.pin=pin;this.identity=identity;storage=new ProtectedStartJournal(pin);
        }
        public void WriteOnce(string name,string value) {
            pin.CheckDeadline();
            if(name=="start.intent" && value!=identity.Encode())throw new InvalidOperationException("Prepared intent differs from permit binding");
            storage.WriteOnce(name,value);
        }
        public string Read(string name) {
            pin.CheckDeadline();string value=storage.Read(name);
            if(name=="start.intent"&&value!=null&&value!=identity.Encode())throw new InvalidOperationException("Consumed intent differs from permit binding");
            return value;
        }
    }
    public sealed partial class ProtectedAttempt {
        public readonly OwnedVmPermit VmPermit;
        public static ProtectedAttempt OpenVmGuardian(string path,string hash) {
            RequireSystem();return new ProtectedAttempt(path,hash,false,900000);
        }
        public static ProtectedAttempt PinVmGuardianController(string path,string hash) {
            RequireAdministrator();return new ProtectedAttempt(path,hash,true,900000);
        }
        private ProtectedAttempt(string path,string expectedHash,bool controller,int guardianWindow) {
            recordOwner=controller?AdminSid:SystemSid;guardianOnly=true;LeaseProfile="vm-guardian";
            Hex(expectedHash,64);LocalPath(path);
            if(guardianWindow!=900000||Path.GetFileName(path)!="vm-permit.txt")throw new ArgumentException("Fixed guardian permit required");
            Root=Path.GetDirectoryName(path);ContractHash=expectedHash;
            try {
                string current=Path.GetPathRoot(Root);HoldDirectory(current,false);
                string[] parts=Root.Substring(3).Split('\\');
                for(int i=0;i<parts.Length;i++){current=Path.Combine(current,parts[i]);HoldDirectory(current,i==parts.Length-1);}
                byte[] bytes=Bytes(HoldRead(path,2048),2048);
                if(Hash(bytes)!=expectedHash)throw new InvalidOperationException("Guardian permit digest differs");
                VmPermit=OwnedVmPermit.Parse(Utf8.GetString(bytes));Nonce=VmPermit.Attempt;Boot=VmPermit.Boot;
                Origin=VmPermit.Origin;Deadline=VmPermit.Deadline;ExecutableHash=VmPermit.ImageHash;
                if(Path.GetFileName(Root)!=Nonce||!String.Equals(VmPermit.ConfigurationRoot,Path.Combine(Root,"vm"),StringComparison.OrdinalIgnoreCase)||Boot!=CurrentBoot())
                    throw new InvalidOperationException("Guardian namespace or boot differs");
                if(Hash(Bytes(HoldRead(Path.Combine(Root,"entry.exe"),262144),262144))!=ExecutableHash)throw new InvalidOperationException("Guardian image differs");
                VmPermit.ValidateAccess(BoundedWorker.MonotonicMilliseconds(),false);CheckDeadline();
            }catch{Dispose();throw;}
        }
        // SYSTEM callers must already be in the independently supervised worker.
        // A lease proves namespace/time binding, not live observer membership.
        public static ProtectedAttempt OpenVmJournal(string permitPath,string expectedHash,ProtectedAttempt lease,bool reconcile) {
            RequireSystem();return new ProtectedAttempt(permitPath,expectedHash,lease,reconcile,false);
        }
        // Trusted operator API for preparing the same protected namespace. This
        // does not bypass HyperVStartProvider's SYSTEM/runtime checks.
        public static ProtectedAttempt PinVmJournalController(string permitPath,string expectedHash,ProtectedAttempt lease,bool reconcile) {
            using(var identity=WindowsIdentity.GetCurrent()) {
                if(identity.ImpersonationLevel!=TokenImpersonationLevel.None ||
                    !new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))throw new InvalidOperationException("Primary administrator required");
            }
            return new ProtectedAttempt(permitPath,expectedHash,lease,reconcile,true);
        }
        private ProtectedAttempt(string path,string expectedHash,ProtectedAttempt lease,bool reconcile,bool controller) {
            recordOwner=controller?AdminSid:SystemSid;
            if(lease==null||lease.accessLease!=null||lease.guardianOnly||lease.VmPermit!=null||
                (lease.LeaseProfile!="inert"&&lease.LeaseProfile!="provider"))throw new ArgumentException("Separate original short worker lease required");
            lease.CheckDeadline();Hex(expectedHash,64);LocalPath(path);
            if(Path.GetFileName(path)!="vm-permit.txt")throw new ArgumentException("Fixed VM permit filename");
            Root=Path.GetDirectoryName(path);ContractHash=expectedHash;accessLease=lease;reconciliationOnly=reconcile;
            if(String.Equals(Root,lease.Root,StringComparison.OrdinalIgnoreCase))throw new ArgumentException("Separate journal and worker namespaces required");
            try {
                string current=Path.GetPathRoot(Root);HoldDirectory(current,false);
                string[] parts=Root.Substring(3).Split('\\');
                for(int i=0;i<parts.Length;i++){current=Path.Combine(current,parts[i]);HoldDirectory(current,i==parts.Length-1);}
                byte[] bytes=Bytes(HoldRead(path,2048),2048);
                if(Hash(bytes)!=expectedHash)throw new InvalidOperationException("Permit digest differs");
                VmPermit=OwnedVmPermit.Parse(Utf8.GetString(bytes));Nonce=VmPermit.Attempt;Boot=VmPermit.Boot;
                Origin=VmPermit.Origin;Deadline=VmPermit.Deadline;ExecutableHash=VmPermit.ImageHash;
                if(Path.GetFileName(Root)!=Nonce||!String.Equals(VmPermit.ConfigurationRoot,Path.Combine(Root,"vm"),StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("VM configuration outside owned attempt");
                if(Boot!=lease.Boot||Boot!=CurrentBoot()||ExecutableHash!=lease.ExecutableHash)throw new InvalidOperationException("Worker boot/image differs from permit");
                if(Hash(Bytes(HoldRead(Path.Combine(Root,"entry.exe"),262144),262144))!=ExecutableHash)throw new InvalidOperationException("Pinned VM worker image differs");
                VmPermit.ValidateAccess(BoundedWorker.MonotonicMilliseconds(),reconcile);
                CheckDeadline();
            }catch{Dispose();throw;}
        }
    }
}
