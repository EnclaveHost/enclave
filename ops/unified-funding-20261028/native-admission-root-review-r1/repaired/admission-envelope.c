/* QUALIFICATION-ONLY TEST ADMISSION ENVELOPE (R1). Not production manager/router/product code.
 * SOURCE ONLY: never built or run here. No CRT, no network, no environment or raw command-line echo,
 * no shell strings from input. One bounded phase per invocation; no retry, no follow-on, no cleanup.
 * Bootstrap boundary: this process must start as the ONLY process (active and total) of an unnamed
 * Job E that a separately reviewed creator configured and assigned while this process was suspended
 * (run-contract.json creatorContract). It never self-assigns. Anything else -> BootstrapUnqualified
 * before any child exists. Test Job T (256), observer Job O (64) and this envelope's own early/steady
 * remainder are all inside E's hard 384 MiB job commit, so P/E/O terms are enforced caps, not estimates.
 * Capacity: admission requires a test-capacity hold at the common allocation boundary. That interface
 * does not exist yet; capacity_hold() refuses, so every invocation stops before child creation.
 * Caller JSON/Booleans are never resource or exclusion evidence. Run-time pressure sampling is best effort.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <bcrypt.h>
#define MIB (1024ULL*1024ULL)
#define TEST_MIB 256ULL
#define OBS_MIB 64ULL
#define ENV_MIB 384ULL /* whole Job E = T 256 + O 64 + envelope remainder 64, all hard job commit */
#define FLOOR_MIB 18432ULL
#define ENV_PROCS 7 /* envelope + observer + T's four + one spare, so T's limit refuses first */
#define ENV_CPU 300000000LL /* Job E user CPU 30 s, 100 ns units */
#define OBS_CPU 50000000LL
#define LIMITS_MS 35000
#define READY_MS 10000
#define DEATH_MS 15000
#define DRAIN_MS 5000
#define UNKNOWN (~0ULL)
#define E_FLAGS (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_JOB_MEMORY|JOB_OBJECT_LIMIT_ACTIVE_PROCESS|JOB_OBJECT_LIMIT_AFFINITY|JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION|JOB_OBJECT_LIMIT_JOB_TIME)
#define T_FLAGS (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_JOB_MEMORY|JOB_OBJECT_LIMIT_ACTIVE_PROCESS|JOB_OBJECT_LIMIT_AFFINITY|JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION)
/* O has no kill-on-close: envelope (owner) death must not kill the observer; E's creator deadline bounds it. */
#define O_FLAGS (JOB_OBJECT_LIMIT_JOB_MEMORY|JOB_OBJECT_LIMIT_ACTIVE_PROCESS|JOB_OBJECT_LIMIT_AFFINITY|JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION|JOB_OBJECT_LIMIT_JOB_TIME)
#ifndef EXPECT_LAUNCHER_SHA256
#define EXPECT_LAUNCHER_SHA256 ""
#endif
#ifndef EXPECT_PROBE_SHA256
#define EXPECT_PROBE_SHA256 ""
#endif
enum {R_OK,R_ARGS,R_BOOTSTRAP,R_CREATOR,R_DOMAIN,R_IMAGE,R_CAPACITY_ABSENT,R_CAPACITY_UNKNOWN,R_HOLD_STALE,R_OVERLAP,R_HOLD_SMALL,R_IMPLAUSIBLE,R_PHYSICAL,R_COMMIT,
 R_SETUP,R_NOT_CONTAINED,R_READY,R_OBSERVER_SETUP,R_OBSERVER_DIED,R_DEATH_UNOBSERVED,R_PRESSURE,R_HOLD_EXPIRED,R_DEADLINE,R_CREATOR_GONE,R_DRAIN_UNKNOWN,R_OUTPUT,R_COUNT};
static const char *names[R_COUNT]={"Completed","ArgumentsRefused","BootstrapUnqualified","CreatorIdentityRefused","TestDomainRefused","ImagePinRefused",
 "CapacityInterfaceAbsent","CapacityUnknown","HoldStale","OverlapUnbounded","HoldTooSmall","CapacityImplausible","PhysicalShortage","CommitShortage",
 "ChildSetupFailedBeforeResume","ContainmentNotProven","ReadyIdentitiesNotProven","ObserverSetupFailed","ObserverDied","DeathNotObserved",
 "PressureStop","HoldExpiredDuringRun","Deadline","CreatorGone","DrainUnknown","OutputBound"};
typedef struct {DWORD pid;ULONGLONG creation;HANDLE h;} OWNED;
/* Remaining source interface: filled only by a reviewed local hold at the shared allocation boundary. */
typedef struct {ULONGLONG incarnation,sequence,liveFloorMiB,physicalMiB,commitMiB,heldMiB,expiresTick;BOOL overlapBounded;} HOLD;
static WCHAR tok[16][33],self[MAX_PATH],dir[MAX_PATH],launcher[MAX_PATH],probe[MAX_PATH],cmd[1024],ps[512];
static char out[4096];static unsigned outn,ntok;static BOOL outOver,nonceOk,launched,drained;
static BYTE image[65536];
static HANDLE creator,heldLauncher,heldProbe,testJob,port,obsJob;
static PROCESS_INFORMATION lp,op;
static OWNED me,tree[3];
static int phase;
static ULONGLONG nonceLow,floorMiB=FLOOR_MIB,launcherExit=UNKNOWN;
static HOLD hold;
static void emit(const char *s){for(unsigned i=0;s[i];i++){if(outn>=sizeof(out)){outOver=TRUE;return;}out[outn++]=s[i];}}
static void number(ULONGLONG n){char b[32],r[32];unsigned i=0,j=0;do{r[i++]=(char)('0'+n%10);n/=10;}while(n);while(i)b[j++]=r[--i];b[j]=0;emit(b);}
static void maybe(ULONGLONG n){if(n==UNKNOWN)emit("null");else number(n);}
static void boolean(BOOL b){emit(b?"true":"false");}
static void outid(const OWNED *o){emit("{\"pid\":");number(o->pid);emit(",\"creationFiletime\":\"");number(o->creation);emit("\"}");}
static void flush_exit(DWORD reason){DWORD w=0;if(outOver){outn=0;outOver=FALSE;reason=R_OUTPUT;emit("{\"reason\":\"OutputBound\",\"nativeQualified\":false}\n");}
 WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),out,outn,&w,NULL);ExitProcess(64+reason);}
static void receipt(DWORD reason){
 emit("{\"schema\":\"enclave-native-admission-envelope/1\",\"phase\":\"");emit(phase==3?"observe":phase==2?"death":phase==1?"limits":"unknown");
 emit("\",\"nonce\":");if(nonceOk){char n[33];for(unsigned i=0;i<33;i++)n[i]=(char)tok[1][i];emit("\"");emit(n);emit("\"");}else emit("null");
 emit(",\"reason\":\"");emit(names[reason]);emit("\",\"self\":");outid(&me);
 emit(",\"hold\":{\"incarnation\":");maybe(hold.incarnation);emit(",\"sequence\":");maybe(hold.sequence);emit(",\"liveFloorMiB\":");maybe(hold.liveFloorMiB);
 emit(",\"physicalMiB\":");maybe(hold.physicalMiB);emit(",\"commitMiB\":");maybe(hold.commitMiB);emit(",\"heldMiB\":");maybe(hold.heldMiB);emit("}");
 emit(",\"effectiveFloorMiB\":");number(floorMiB);emit(",\"envelopeJobCommitMiB\":");number(ENV_MIB);
 emit(",\"launched\":");boolean(launched);emit(",\"tree\":[");for(unsigned i=0;i<3;i++){if(i)emit(",");outid(&tree[i]);}
 emit("],\"launcherExit\":");maybe(launcherExit);emit(",\"testJobDrained\":");boolean(drained);
 emit(",\"actualWindowsAdmission\":false,\"limitAttributionQualified\":false,\"ownerDeathQualified\":false,\"nativeQualified\":false}\n");
 flush_exit(reason);
}
static unsigned length(const WCHAR *s){unsigned n=0;while(s[n])n++;return n;}
static BOOL append(WCHAR *dst,unsigned cap,const WCHAR *s){unsigned d=length(dst),n=length(s);if(d+n>=cap)return FALSE;for(unsigned i=0;i<=n;i++)dst[d+i]=s[i];return TRUE;}
static BOOL appendn(WCHAR *dst,unsigned cap,ULONGLONG v,unsigned base){WCHAR r[24],b[26];unsigned i=0,j=0;b[j++]=L' ';
 do{unsigned d=(unsigned)(v%base);r[i++]=(WCHAR)(d<10?L'0'+d:L'a'+d-10);v/=base;}while(v);while(i)b[j++]=r[--i];b[j]=0;return append(dst,cap,b);}
static BOOL eq(const WCHAR *a,const char *b){unsigned i=0;for(;a[i]&&b[i];i++)if(a[i]!=(WCHAR)b[i])return FALSE;return !a[i]&&!b[i];}
static BOOL dec(const WCHAR *s,ULONGLONG *v){ULONGLONG r=0;if(!s[0]||(s[0]==L'0'&&s[1]))return FALSE;
 for(unsigned i=0;s[i];i++){if(s[i]<L'0'||s[i]>L'9'||r>(UNKNOWN-9)/10)return FALSE;r=r*10+(ULONGLONG)(s[i]-L'0');}*v=r;return TRUE;}
static BOOL hexv(const WCHAR *s,ULONGLONG *v){ULONGLONG r=0;unsigned i=0;
 for(;s[i];i++){if(i>=16)return FALSE;WCHAR c=s[i];unsigned d=c>=L'0'&&c<=L'9'?(unsigned)(c-L'0'):c>=L'a'&&c<=L'f'?(unsigned)(c-L'a'+10):16;if(d>15)return FALSE;r=r<<4|d;}*v=r;return i>0;}
/* At most 16 tokens of [0-9a-z]{1,32} after the program token; whole line at most 1024 characters. */
static BOOL tokenize(void){const WCHAR *p=GetCommandLineW();if(length(p)>1024)return FALSE;
 if(*p==L'"'){p++;while(*p&&*p!=L'"')p++;if(!*p)return FALSE;p++;}else while(*p&&*p!=L' '&&*p!=L'\t')p++;
 for(;;){while(*p==L' '||*p==L'\t')p++;if(!*p)return ntok>0;if(ntok>=16)return FALSE;unsigned n=0;
  while(*p&&*p!=L' '&&*p!=L'\t'){WCHAR c=*p++;if(n>=32||!((c>=L'0'&&c<=L'9')||(c>=L'a'&&c<=L'z')))return FALSE;tok[ntok][n++]=c;}tok[ntok++][n]=0;}}
static BOOL nonce(void){ULONGLONG hi=0;if(length(tok[1])!=32)return FALSE;WCHAR h[17];
 for(unsigned i=0;i<16;i++)h[i]=tok[1][i];h[16]=0;if(!hexv(h,&hi)||!hexv(tok[1]+16,&nonceLow)||(!hi&&!nonceLow))return FALSE;return nonceOk=TRUE;}
static BOOL identity(HANDLE h,DWORD pid,OWNED *o){FILETIME c,e,k,u;o->pid=pid;o->h=h;if(!GetProcessTimes(h,&c,&e,&k,&u))return FALSE;o->creation=((ULONGLONG)c.dwHighDateTime<<32)|c.dwLowDateTime;return o->creation!=0;}
static BOOL accounting(HANDLE job,DWORD active,DWORD total){JOBOBJECT_BASIC_ACCOUNTING_INFORMATION a;
 return QueryInformationJobObject(job,JobObjectBasicAccountingInformation,&a,sizeof(a),NULL)&&a.ActiveProcesses==active&&a.TotalProcesses==total;}
/* Immediate job, exact flags (so no breakaway flags), exact caps, and this process alone since before entry. */
static BOOL in_exact_job(DWORD flags,ULONGLONG capMiB,DWORD procs,LONGLONG cpu){JOBOBJECT_EXTENDED_LIMIT_INFORMATION x;BOOL in=FALSE;
 return IsProcessInJob(GetCurrentProcess(),NULL,&in)&&in&&QueryInformationJobObject(NULL,JobObjectExtendedLimitInformation,&x,sizeof(x),NULL)&&
  x.BasicLimitInformation.LimitFlags==flags&&x.JobMemoryLimit==capMiB*MIB&&x.BasicLimitInformation.ActiveProcessLimit==procs&&
  x.BasicLimitInformation.Affinity==1&&x.BasicLimitInformation.PerJobUserTimeLimit.QuadPart==cpu&&accounting(NULL,1,1);}
static BOOL configure(HANDLE job,DWORD flags,ULONGLONG capMiB,DWORD procs,LONGLONG cpu){JOBOBJECT_EXTENDED_LIMIT_INFORMATION x={0};
 x.BasicLimitInformation.LimitFlags=flags;x.JobMemoryLimit=capMiB*MIB;x.BasicLimitInformation.ActiveProcessLimit=procs;x.BasicLimitInformation.Affinity=1;
 x.BasicLimitInformation.PerJobUserTimeLimit.QuadPart=cpu;return SetInformationJobObject(job,JobObjectExtendedLimitInformation,&x,sizeof(x));}
/* Test directory must be ...\enclave-native-admission-test-<nonce>, with no reparse point on any component. */
static DWORD domain(void){UINT n=GetModuleFileNameW(NULL,self,MAX_PATH);unsigned slash=0,base=0;if(!n||n>=MAX_PATH)return R_DOMAIN;
 for(unsigned i=0;i<n;i++)if(self[i]==L'\\')slash=i;if(slash<3)return R_DOMAIN;for(unsigned i=0;i<slash;i++){dir[i]=self[i];if(self[i]==L'\\')base=i+1;}dir[slash]=0;
 const char *prefix="enclave-native-admission-test-";unsigned k=0;for(;prefix[k];k++)if(dir[base+k]!=(WCHAR)prefix[k])return R_DOMAIN;
 for(unsigned i=0;i<33;i++)if(dir[base+k+i]!=tok[1][i])return R_DOMAIN;
 for(unsigned i=3;i<=slash;i++)if(i==slash||dir[i]==L'\\'){WCHAR c=dir[i];dir[i]=0;DWORD a=GetFileAttributesW(dir);dir[i]=c;
  if(a==INVALID_FILE_ATTRIBUTES||!(a&FILE_ATTRIBUTE_DIRECTORY)||(a&FILE_ATTRIBUTE_REPARSE_POINT))return R_DOMAIN;}
 if(!append(launcher,MAX_PATH,dir)||!append(launcher,MAX_PATH,L"\\owned-job.exe")||!append(probe,MAX_PATH,dir)||!append(probe,MAX_PATH,L"\\job-probe.exe"))return R_DOMAIN;
 return R_OK;}
/* Hash through a deny-write/delete handle held for the whole phase; one link, no reparse, bounded size. */
static DWORD pin(const WCHAR *path,const char *expect,HANDLE *held){BY_HANDLE_FILE_INFORMATION i;BYTE d[32];DWORD got=0;const char *hx="0123456789abcdef";
 unsigned e=0;while(expect[e])e++;if(e!=64)return R_IMAGE;
 HANDLE f=CreateFileW(path,GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,NULL);if(f==INVALID_HANDLE_VALUE)return R_IMAGE;*held=f;
 if(!GetFileInformationByHandle(f,&i)||(i.dwFileAttributes&(FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_DIRECTORY))||i.nNumberOfLinks!=1||i.nFileSizeHigh||!i.nFileSizeLow||i.nFileSizeLow>sizeof(image))return R_IMAGE;
 if(!ReadFile(f,image,i.nFileSizeLow,&got,NULL)||got!=i.nFileSizeLow||BCryptHash(BCRYPT_SHA256_ALG_HANDLE,NULL,0,image,got,d,32)!=0)return R_IMAGE;
 for(unsigned j=0;j<32;j++)if(expect[2*j]!=hx[d[j]>>4]||expect[2*j+1]!=hx[d[j]&15])return R_IMAGE;return R_OK;}
/* REMAINING INTERFACE (absent): local owner test-capacity hold at the actual shared allocation boundary,
 * honoured by every manager and direct admission path, exact incarnation/sequence, outstanding physical and
 * commit upper bounds, validated live floor, held budget >= ENV_MIB and finite expiry. Until a reviewed
 * native query exists, every field stays UNKNOWN and admission refuses. Not fed from argv, files or JSON. */
static DWORD capacity_hold(HOLD *h){h->incarnation=h->sequence=h->liveFloorMiB=h->physicalMiB=h->commitMiB=h->heldMiB=UNKNOWN;h->expiresTick=0;h->overlapBounded=FALSE;return R_CAPACITY_ABSENT;}
static DWORD admit(void){MEMORYSTATUSEX m;ULONGLONG t[4]={hold.liveFloorMiB,hold.physicalMiB,hold.commitMiB,hold.heldMiB};
 for(unsigned i=0;i<4;i++)if(t[i]==UNKNOWN)return R_CAPACITY_UNKNOWN;if(!hold.overlapBounded)return R_OVERLAP;
 if(!hold.expiresTick||GetTickCount64()>=hold.expiresTick)return R_HOLD_STALE;
 m.dwLength=sizeof(m);if(!GlobalMemoryStatusEx(&m))return R_CAPACITY_UNKNOWN;
 for(unsigned i=0;i<4;i++)if(t[i]>m.ullTotalPageFile/MIB)return R_IMPLAUSIBLE; /* also catches wrapped negatives; bounds the sums below */
 floorMiB=hold.liveFloorMiB>FLOOR_MIB?hold.liveFloorMiB:FLOOR_MIB;if(hold.heldMiB<ENV_MIB)return R_HOLD_SMALL;
 if(m.ullAvailPhys/MIB<floorMiB+hold.physicalMiB+ENV_MIB)return R_PHYSICAL;
 if(m.ullAvailPageFile/MIB<hold.commitMiB+ENV_MIB)return R_COMMIT;return R_OK;}
/* Best effort only: sampling cannot stop a concurrent allocation between samples. */
static DWORD pressure(void){MEMORYSTATUSEX m;m.dwLength=sizeof(m);if(GetTickCount64()>=hold.expiresTick)return R_HOLD_EXPIRED;
 if(!GlobalMemoryStatusEx(&m)||m.ullAvailPhys/MIB<floorMiB+hold.physicalMiB)return R_PRESSURE;return R_OK;}
static DWORD watch(HANDLE target,DWORD ms){HANDLE w[2]={target,creator};ULONGLONG start=GetTickCount64();
 for(;;){DWORD r=WaitForMultipleObjects(2,w,FALSE,50);if(r==WAIT_OBJECT_0)return R_OK;if(r==WAIT_OBJECT_0+1)return R_CREATOR_GONE;if(r!=WAIT_TIMEOUT)return R_SETUP;
  DWORD p=pressure();if(p)return p;if(GetTickCount64()-start>=ms)return R_DEADLINE;}}
/* Retain uncertainty: drained stays false unless T is observed empty and the launcher handle is signalled. */
static void stop_test(void){ULONGLONG s=GetTickCount64();JOBOBJECT_BASIC_ACCOUNTING_INFORMATION a;
 if(lp.hProcess&&!launched)TerminateProcess(lp.hProcess,64+R_SETUP);if(testJob)TerminateJobObject(testJob,64+R_DEADLINE);
 for(;;){BOOL empty=!testJob||(QueryInformationJobObject(testJob,JobObjectBasicAccountingInformation,&a,sizeof(a),NULL)&&!a.ActiveProcesses);
  if(empty&&(!lp.hProcess||WaitForSingleObject(lp.hProcess,0)==WAIT_OBJECT_0)){drained=TRUE;return;}if(GetTickCount64()-s>=DRAIN_MS)return;Sleep(50);}}
static void fail(DWORD reason){stop_test();receipt(reason);}
static BOOL encode_ps(const char *s){static const char b[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";BYTE in[256];unsigned n=0,o=0;
 for(unsigned i=0;s[i];i++){if(n+2>sizeof(in))return FALSE;in[n++]=(BYTE)s[i];in[n++]=0;} /* UTF-16LE of fixed ASCII */
 for(unsigned i=0;i<n;i+=3){unsigned v=(unsigned)in[i]<<16|(i+1<n?(unsigned)in[i+1]<<8:0)|(i+2<n?in[i+2]:0);if(o+5>sizeof(ps)/sizeof(ps[0]))return FALSE;
  ps[o++]=(WCHAR)b[v>>18&63];ps[o++]=(WCHAR)b[v>>12&63];ps[o++]=i+1<n?(WCHAR)b[v>>6&63]:L'=';ps[o++]=i+2<n?(WCHAR)b[v&63]:L'=';}ps[o]=0;return TRUE;}
static BOOL attributes(STARTUPINFOEXW *si,HANDLE *list,unsigned count){static union{void *alignment;BYTE bytes[4096];}store;SIZE_T bytes=0;
 InitializeProcThreadAttributeList(NULL,1,0,&bytes);if(!bytes||bytes>sizeof(store.bytes))return FALSE;si->lpAttributeList=(LPPROC_THREAD_ATTRIBUTE_LIST)store.bytes;
 return InitializeProcThreadAttributeList(si->lpAttributeList,1,0,&bytes)&&UpdateProcThreadAttribute(si->lpAttributeList,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,list,count*sizeof(HANDLE),NULL,NULL);}
/* Job T exists and is configured before the suspended launcher exists; launcher is assigned before its first instruction. */
static DWORD launch_test(void){static STARTUPINFOEXW si;static HANDLE std3[3];DWORD names3[3]={STD_INPUT_HANDLE,STD_OUTPUT_HANDLE,STD_ERROR_HANDLE};
 JOBOBJECT_ASSOCIATE_COMPLETION_PORT acp;BOOL member=FALSE;
 if(!encode_ps(phase==2?"& .\\job-probe.exe child; exit $LASTEXITCODE":"& .\\job-probe.exe; exit $LASTEXITCODE"))return R_SETUP;
 if(!append(cmd,1024,L"\"")||!append(cmd,1024,launcher)||!append(cmd,1024,L"\" ")||!append(cmd,1024,ps))return R_SETUP;
 testJob=CreateJobObjectW(NULL,NULL);if(!testJob||!configure(testJob,T_FLAGS,TEST_MIB,4,0))return R_SETUP;
 port=CreateIoCompletionPort(INVALID_HANDLE_VALUE,NULL,0,1);if(!port)return R_SETUP;acp.CompletionKey=(PVOID)1;acp.CompletionPort=port;
 if(!SetInformationJobObject(testJob,JobObjectAssociateCompletionPortInformation,&acp,sizeof(acp)))return R_SETUP;
 for(unsigned i=0;i<3;i++)if(!DuplicateHandle(GetCurrentProcess(),GetStdHandle(names3[i]),GetCurrentProcess(),&std3[i],0,TRUE,DUPLICATE_SAME_ACCESS))return R_SETUP;
 if(!attributes(&si,std3,3))return R_SETUP;si.StartupInfo.cb=sizeof(si);si.StartupInfo.dwFlags=STARTF_USESTDHANDLES;
 si.StartupInfo.hStdInput=std3[0];si.StartupInfo.hStdOutput=std3[1];si.StartupInfo.hStdError=std3[2];
 BOOL created=CreateProcessW(launcher,cmd,NULL,NULL,TRUE,CREATE_SUSPENDED|CREATE_NO_WINDOW|EXTENDED_STARTUPINFO_PRESENT,NULL,dir,&si.StartupInfo,&lp);
 DeleteProcThreadAttributeList(si.lpAttributeList);for(unsigned i=0;i<3;i++)CloseHandle(std3[i]);if(!created)return R_SETUP;
 if(!identity(lp.hProcess,lp.dwProcessId,&tree[0])||!AssignProcessToJobObject(testJob,lp.hProcess))return R_SETUP;
 if(!IsProcessInJob(lp.hProcess,testJob,&member)||!member||!accounting(testJob,1,1))return R_NOT_CONTAINED;
 DWORD r=admit();if(r)return r; /* fresh re-admission immediately before the first launcher instruction */
 if(ResumeThread(lp.hThread)==(DWORD)-1)return R_SETUP;launched=TRUE;CloseHandle(lp.hThread);lp.hThread=NULL;return R_OK;}
/* Exact child-ready identities from T's own port; PIDs are opened only while proven members of T. Any exit first refuses. */
static DWORD ready(void){ULONGLONG s=GetTickCount64();BOOL member=FALSE;
 for(unsigned have=0;have<3;have++){DWORD msg=0;ULONG_PTR key=0;LPOVERLAPPED ov=NULL;ULONGLONG el=GetTickCount64()-s;if(el>=READY_MS)return R_READY;
  if(!GetQueuedCompletionStatus(port,&msg,&key,&ov,(DWORD)(READY_MS-el))||key!=1||msg!=JOB_OBJECT_MSG_NEW_PROCESS)return R_READY;
  DWORD pid=(DWORD)(ULONG_PTR)ov;OWNED *o=&tree[have];
  if(!have){if(pid!=lp.dwProcessId)return R_READY;o->h=lp.hProcess;}
  else{HANDLE h=OpenProcess(SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid);if(!h)return R_READY;o->h=h;
   if(!IsProcessInJob(h,testJob,&member)||!member||!identity(h,pid,o)||o->creation<tree[0].creation)return R_READY;}
  if(WaitForSingleObject(o->h,0)!=WAIT_TIMEOUT)return R_READY;}
 if(!accounting(testJob,3,3))return R_READY;return pressure();}
/* Observer: outside T, in its own capped Job O, inherits exactly stdout + this envelope + three tree handles. Never T. */
static DWORD spawn_observer(void){static STARTUPINFOEXW si;HANDLE inh[5]={0};BOOL inT=TRUE,inO=FALSE;DWORD r=R_OBSERVER_SETUP;
 obsJob=CreateJobObjectW(NULL,NULL);if(!obsJob||!configure(obsJob,O_FLAGS,OBS_MIB,1,OBS_CPU))return r;
 if(!DuplicateHandle(GetCurrentProcess(),GetStdHandle(STD_OUTPUT_HANDLE),GetCurrentProcess(),&inh[0],0,TRUE,DUPLICATE_SAME_ACCESS)||
  !DuplicateHandle(GetCurrentProcess(),GetCurrentProcess(),GetCurrentProcess(),&inh[1],PROCESS_TERMINATE|SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,TRUE,0))goto done;
 for(unsigned i=0;i<3;i++)if(!DuplicateHandle(GetCurrentProcess(),tree[i].h,GetCurrentProcess(),&inh[2+i],SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,TRUE,0))goto done;
 cmd[0]=0;if(!append(cmd,1024,L"\"")||!append(cmd,1024,self)||!append(cmd,1024,L"\" observe ")||!append(cmd,1024,tok[1])||!appendn(cmd,1024,floorMiB,10)||
  !appendn(cmd,1024,(ULONG_PTR)inh[1],16)||!appendn(cmd,1024,me.pid,10)||!appendn(cmd,1024,me.creation,10))goto done;
 for(unsigned i=0;i<3;i++)if(!appendn(cmd,1024,(ULONG_PTR)inh[2+i],16)||!appendn(cmd,1024,tree[i].pid,10)||!appendn(cmd,1024,tree[i].creation,10))goto done;
 if(!attributes(&si,inh,5))goto done;si.StartupInfo.cb=sizeof(si);si.StartupInfo.dwFlags=STARTF_USESTDHANDLES;
 si.StartupInfo.hStdInput=si.StartupInfo.hStdOutput=si.StartupInfo.hStdError=inh[0];
 BOOL created=CreateProcessW(self,cmd,NULL,NULL,TRUE,CREATE_SUSPENDED|CREATE_NO_WINDOW|EXTENDED_STARTUPINFO_PRESENT,NULL,dir,&si.StartupInfo,&op);
 DeleteProcThreadAttributeList(si.lpAttributeList);if(!created)goto done;
 if(!AssignProcessToJobObject(obsJob,op.hProcess)||!IsProcessInJob(op.hProcess,obsJob,&inO)||!inO||!IsProcessInJob(op.hProcess,testJob,&inT)||inT||
  !accounting(obsJob,1,1)||pressure()||ResumeThread(op.hThread)==(DWORD)-1){TerminateProcess(op.hProcess,64+R_OBSERVER_SETUP);WaitForSingleObject(op.hProcess,DRAIN_MS);goto done;}
 CloseHandle(op.hThread);r=R_OK;
 done:for(unsigned i=0;i<5;i++)if(inh[i])CloseHandle(inh[i]);return r;}
/* Independent observer phase body: exact handles only; terminate exactly the owner, then wait exact descendants. */
/* Root review: an arbitrary terminate-capable handle is not TEST invocation provenance.
 * No installed one-shot capability binds this observer to an enrolled TEST owner/tree.
 * Keep this independent gate closed even if capacity_hold is implemented later.
 * No argv/JSON/environment/job-shape Boolean may discharge it. */
static DWORD observer_invocation_provenance(void){return R_READY;}
static void observer(void){ULONGLONG v[15];OWNED w,d[3];HANDLE hd[3];FILETIME act,c,e,k,u;DWORD wcode=0,termErr=0;BOOL early=FALSE,alive=TRUE;
 if(ntok!=15||!nonce()||!dec(tok[2],&v[2])||v[2]<FLOOR_MIB)receipt(R_ARGS);floorMiB=v[2];
 for(unsigned i=3;i<15;i++)if(!((i%3==0)?hexv(tok[i],&v[i]):dec(tok[i],&v[i])))receipt(R_ARGS);
 if(!in_exact_job(O_FLAGS,OBS_MIB,1,OBS_CPU))receipt(R_BOOTSTRAP);
 if(!identity((HANDLE)(ULONG_PTR)v[3],(DWORD)v[4],&w)||GetProcessId(w.h)!=v[4]||w.creation!=v[5])receipt(R_READY);
 for(unsigned i=0;i<3;i++){hd[i]=(HANDLE)(ULONG_PTR)v[6+3*i];if(!identity(hd[i],(DWORD)v[7+3*i],&d[i])||GetProcessId(hd[i])!=v[7+3*i]||d[i].creation!=v[8+3*i])receipt(R_READY);
  tree[i]=d[i];if(WaitForSingleObject(hd[i],0)!=WAIT_TIMEOUT)alive=FALSE;}
 if(WaitForSingleObject(w.h,0)!=WAIT_TIMEOUT)alive=FALSE;
 UINT code=0x4F000000u|(UINT)(nonceLow&0xFFFFFFu);GetSystemTimeAsFileTime(&act);
 BOOL termOk=alive&&TerminateProcess(w.h,code);if(alive&&!termOk)termErr=GetLastError();
 BOOL wrapperGone=WaitForSingleObject(w.h,DRAIN_MS)==WAIT_OBJECT_0&&GetExitCodeProcess(w.h,&wcode);
 BOOL gone=WaitForMultipleObjects(3,hd,TRUE,DRAIN_MS)<WAIT_OBJECT_0+3;ULONGLONG actAt=((ULONGLONG)act.dwHighDateTime<<32)|act.dwLowDateTime;
 for(unsigned i=0;i<3&&gone;i++)if(!GetProcessTimes(hd[i],&c,&e,&k,&u)||(((ULONGLONG)e.dwHighDateTime<<32)|e.dwLowDateTime)<actAt)early=TRUE;
 MEMORYSTATUSEX m;m.dwLength=sizeof(m);BOOL recovered=GlobalMemoryStatusEx(&m)&&m.ullAvailPhys/MIB>=floorMiB;
 void *probeAlloc=VirtualAlloc(NULL,MIB,MEM_COMMIT|MEM_RESERVE,PAGE_READWRITE);BOOL allocOk=probeAlloc&&VirtualFree(probeAlloc,0,MEM_RELEASE);
 const char *outcome=!alive?"notAliveBeforeAction":!termOk||!wrapperGone||!gone?"unknown":wcode!=code?"wrapperExitedOtherwise":early?"descendantExitedBeforeAction":"ownerDeathObservedUnqualified";
 emit("{\"schema\":\"enclave-native-admission-observer/1\",\"outcome\":\"");emit(outcome);emit("\",\"wrapper\":");outid(&w);emit(",\"descendants\":[");
 for(unsigned i=0;i<3;i++){if(i)emit(",");outid(&d[i]);}emit("],\"terminateError\":");number(termErr);emit(",\"wrapperExitCode\":");number(wcode);
 emit(",\"expectedCode\":");number(code);emit(",\"wrapperGone\":");boolean(wrapperGone);emit(",\"descendantsGone\":");boolean(gone);
 emit(",\"positiveControls\":{\"allAliveBeforeAction\":");boolean(alive);emit(",\"availablePhysicalAtLeastFloor\":");boolean(recovered);emit(",\"observerAllocationWithinCap\":");boolean(allocOk);
 emit("},\"ownerDeathQualified\":false,\"nativeQualified\":false}\n");flush_exit(R_OK);}
void WINAPI entry(void){
 hold.incarnation=hold.sequence=hold.liveFloorMiB=hold.physicalMiB=hold.commitMiB=hold.heldMiB=UNKNOWN;
 if(!identity(GetCurrentProcess(),GetCurrentProcessId(),&me)||!tokenize())receipt(R_ARGS);
 phase=eq(tok[0],"limits")?1:eq(tok[0],"death")?2:eq(tok[0],"observe")?3:0;if(!phase)receipt(R_ARGS);
 if(phase==3){DWORD provenance=observer_invocation_provenance();if(provenance)receipt(provenance);observer();}
 ULONGLONG cpid=0,ccre=0,ch=0;OWNED c;
 if(ntok!=5||!nonce()||!dec(tok[2],&cpid)||!cpid||!dec(tok[3],&ccre)||!hexv(tok[4],&ch))receipt(R_ARGS);
 /* Pre-entry boundary first: nothing below runs unless the creator already contained this process. */
 if(!in_exact_job(E_FLAGS,ENV_MIB,ENV_PROCS,ENV_CPU))receipt(R_BOOTSTRAP);
 creator=(HANDLE)(ULONG_PTR)ch;
 if(!identity(creator,(DWORD)cpid,&c)||GetProcessId(creator)!=cpid||c.creation!=ccre||ccre>=me.creation||WaitForSingleObject(creator,0)!=WAIT_TIMEOUT)receipt(R_CREATOR);
 DWORD r=domain();if(r)receipt(r);
 if((r=pin(launcher,EXPECT_LAUNCHER_SHA256,&heldLauncher))||(r=pin(probe,EXPECT_PROBE_SHA256,&heldProbe)))receipt(r);
 if((r=capacity_hold(&hold))||(r=admit()))receipt(r);
 if((r=launch_test()))fail(r);
 if(phase==1){r=watch(lp.hProcess,LIMITS_MS);if(!r){DWORD x=0;if(GetExitCodeProcess(lp.hProcess,&x))launcherExit=x;}stop_test();receipt(r?r:drained?R_OK:R_DRAIN_UNKNOWN);}
 if((r=ready())||(r=spawn_observer()))fail(r);
 /* Expected end of this process is TerminateProcess by the observer; returning here means no owner death. */
 r=watch(op.hProcess,DEATH_MS);fail(r==R_OK?R_OBSERVER_DIED:r==R_DEADLINE?R_DEATH_UNOBSERVED:r);
}
