/* SOURCE ONLY, never built/run here. Coordinator reviews/builds/admission separately.
 * Receipts are observations, not causal limit qualification. No CRT, no network.
 * Launcher -> PowerShell -> probe; same executable children occupy fourth slot.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#define CAP (256ULL*1024ULL*1024ULL)
#define CHUNK (1024ULL*1024ULL)
static WCHAR exe[MAX_PATH],cmd[MAX_PATH+16];
static void *allocs[256];
typedef struct {DWORD pid,error; ULONGLONG creation;} ID;
typedef struct {BOOL ok;DWORD error;JOBOBJECT_BASIC_ACCOUNTING_INFORMATION value;} ACCOUNT;
static void emit(const char *s){DWORD n=0,w=0;while(s[n])n++;if(!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),s,n,&w,NULL)||w!=n)ExitProcess(90);}
static void number(ULONGLONG n){char b[32],r[32];unsigned i=0,j=0;do{r[i++]=(char)('0'+n%10);n/=10;}while(n);while(i)b[j++]=r[--i];b[j]=0;emit(b);}
static void boolean(BOOL b){emit(b?"true":"false");}
static ID identity(HANDLE h,DWORD pid){ID r={0};FILETIME c,e,k,u;r.pid=pid;if(!GetProcessTimes(h,&c,&e,&k,&u))r.error=GetLastError();else r.creation=((ULONGLONG)c.dwHighDateTime<<32)|c.dwLowDateTime;return r;}
static void outid(ID r){emit("{\"pid\":");number(r.pid);emit(",\"creationFiletime\":\"");number(r.creation);emit("\",\"queryError\":");number(r.error);emit("}");}
static ACCOUNT account(void){ACCOUNT a={0};a.ok=QueryInformationJobObject(NULL,JobObjectBasicAccountingInformation,&a.value,sizeof(a.value),NULL);if(!a.ok)a.error=GetLastError();return a;}
static void outaccount(ACCOUNT a){emit("{\"querySucceeded\":");boolean(a.ok);emit(",\"queryError\":");number(a.error);emit(",\"activeProcesses\":");number(a.value.ActiveProcesses);emit(",\"totalProcesses\":");number(a.value.TotalProcesses);emit(",\"totalTerminatedProcesses\":");number(a.value.TotalTerminatedProcesses);emit("}");}
static BOOL member(void){BOOL b=FALSE;return IsProcessInJob(GetCurrentProcess(),NULL,&b)&&b;}
static BOOL limits_ok(JOBOBJECT_EXTENDED_LIMIT_INFORMATION *x){
 DWORD need=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_JOB_MEMORY|JOB_OBJECT_LIMIT_ACTIVE_PROCESS|JOB_OBJECT_LIMIT_AFFINITY;
 return member()&&QueryInformationJobObject(NULL,JobObjectExtendedLimitInformation,x,sizeof(*x),NULL)&&
 (x->BasicLimitInformation.LimitFlags&need)==need&&
 !(x->BasicLimitInformation.LimitFlags&(JOB_OBJECT_LIMIT_BREAKAWAY_OK|JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK))&&
 x->JobMemoryLimit==CAP&&x->BasicLimitInformation.ActiveProcessLimit==4&&x->BasicLimitInformation.Affinity==1;
}
/* Capture failing API error before any subsequent call; zero on success is explicit. */
static BOOL create_child(DWORD extra,PROCESS_INFORMATION *pi,DWORD *error){
 STARTUPINFOW si={0};si.cb=sizeof(si);unsigned n=0;cmd[n++]=L'"';for(unsigned i=0;exe[i];i++)cmd[n++]=exe[i];
 const WCHAR *tail=L"\" child";for(unsigned i=0;;i++){cmd[n++]=tail[i];if(!tail[i])break;}
 BOOL ok=CreateProcessW(exe,cmd,NULL,NULL,FALSE,CREATE_SUSPENDED|CREATE_NO_WINDOW|extra,NULL,NULL,&si,pi);
 *error=ok?0:GetLastError();return ok;
}
static BOOL child_member(PROCESS_INFORMATION *pi){BOOL b=FALSE;return IsProcessInJob(pi->hProcess,NULL,&b)&&b;}
static BOOL remove_child(PROCESS_INFORMATION *pi){
 if(!TerminateProcess(pi->hProcess,77)&&WaitForSingleObject(pi->hProcess,0)!=WAIT_OBJECT_0)return FALSE;
 BOOL done=WaitForSingleObject(pi->hProcess,1000)==WAIT_OBJECT_0;CloseHandle(pi->hThread);CloseHandle(pi->hProcess);return done;
}
void WINAPI entry(void){
 const WCHAR *p=GetCommandLineW();if(*p==L'"'){p++;while(*p&&*p!=L'"')p++;if(!*p)ExitProcess(91);p++;}else while(*p&&*p!=L' '&&*p!=L'\t')p++;
 while(*p==L' '||*p==L'\t')p++;
 JOBOBJECT_EXTENDED_LIMIT_INFORMATION lim={0};
 if(*p){const WCHAR *word=L"child";unsigned i=0;while(word[i]&&p[i]==word[i])i++;if(word[i]||p[i])ExitProcess(91);if(!limits_ok(&lim))ExitProcess(92);Sleep(2000);ExitProcess(0);}
 if(!limits_ok(&lim)){emit("{\"evidenceCollected\":false,\"reason\":\"limits\"}\n");ExitProcess(1);}
 ACCOUNT baseline=account();if(!baseline.ok||baseline.value.ActiveProcesses!=3){emit("{\"evidenceCollected\":false,\"reason\":\"baseline\"}\n");ExitProcess(2);}
 ID self=identity(GetCurrentProcess(),GetCurrentProcessId());
 UINT n=GetModuleFileNameW(NULL,exe,MAX_PATH);if(!n||n>=MAX_PATH)ExitProcess(3);
 PROCESS_INFORMATION one={0},two={0},br={0};DWORD firstError=0,slotError=0,breakError=0,recoveryError=0,childExit=99;
 if(!create_child(0,&one,&firstError)){emit("{\"evidenceCollected\":false,\"firstChildCreateError\":");number(firstError);emit("}\n");ExitProcess(4);}
 ID first=identity(one.hProcess,one.dwProcessId);
 if(!child_member(&one)){remove_child(&one);ExitProcess(5);}
 ACCOUNT beforeSlot=account();BOOL slotCreated=create_child(0,&two,&slotError);ID unexpectedSlot={0};
 if(slotCreated){unexpectedSlot=identity(two.hProcess,two.dwProcessId);if(!remove_child(&two)){remove_child(&one);ExitProcess(6);}}
 ACCOUNT afterSlot=account();
 if(ResumeThread(one.hThread)==(DWORD)-1){remove_child(&one);ExitProcess(7);}
 if(WaitForSingleObject(one.hProcess,2500)!=WAIT_OBJECT_0){remove_child(&one);ExitProcess(8);}
 BOOL exitRead=GetExitCodeProcess(one.hProcess,&childExit);CloseHandle(one.hThread);CloseHandle(one.hProcess);
 ACCOUNT beforeBreak=account();BOOL breakCreated=create_child(CREATE_BREAKAWAY_FROM_JOB,&br,&breakError);ID unexpectedBreak={0};
 if(breakCreated){unexpectedBreak=identity(br.hProcess,br.dwProcessId);if(!remove_child(&br))ExitProcess(9);}
 ACCOUNT afterBreak=account();BOOL recovered=create_child(0,&two,&recoveryError);ID recoveryId={0};BOOL recoveryMember=FALSE;
 if(recovered){recoveryId=identity(two.hProcess,two.dwProcessId);recoveryMember=child_member(&two);if(!remove_child(&two))ExitProcess(10);}
 ACCOUNT afterRecovery=account();
 MEMORYSTATUSEX m={0};m.dwLength=sizeof(m);
 if(!GlobalMemoryStatusEx(&m)||m.ullAvailPhys<17ULL*1024ULL*1024ULL*1024ULL||m.ullAvailPageFile<CAP)ExitProcess(11);
 JOBOBJECT_EXTENDED_LIMIT_INFORMATION beforeMemory={0};BOOL beforeMemoryOk=QueryInformationJobObject(NULL,JobObjectExtendedLimitInformation,&beforeMemory,sizeof(beforeMemory),NULL);DWORD beforeMemoryError=beforeMemoryOk?0:GetLastError();
 DWORD allocError=0;BOOL refused=FALSE,timedOut=FALSE;unsigned used=0;ULONGLONG begin=GetTickCount64();
 for(used=0;used<256;used++){
  if(GetTickCount64()-begin>5000){timedOut=TRUE;break;}
  allocs[used]=VirtualAlloc(NULL,CHUNK,MEM_COMMIT|MEM_RESERVE,PAGE_READWRITE);
  if(!allocs[used]){allocError=GetLastError();refused=TRUE;break;}
  for(unsigned off=0;off<CHUNK;off+=4096)((volatile BYTE*)allocs[used])[off]=1;
 }
 JOBOBJECT_EXTENDED_LIMIT_INFORMATION peak={0};BOOL peakOk=QueryInformationJobObject(NULL,JobObjectExtendedLimitInformation,&peak,sizeof(peak),NULL);DWORD peakError=peakOk?0:GetLastError();
 MEMORYSTATUSEX afterMemory={0};afterMemory.dwLength=sizeof(afterMemory);BOOL memoryRead=GlobalMemoryStatusEx(&afterMemory);DWORD memoryReadError=memoryRead?0:GetLastError();
 BOOL freeOk=TRUE;DWORD freeError=0;for(unsigned i=0;i<used;i++)if(!VirtualFree(allocs[i],0,MEM_RELEASE)){DWORD e=GetLastError();freeOk=FALSE;if(!freeError)freeError=e;}
 void *again=VirtualAlloc(NULL,CHUNK,MEM_COMMIT|MEM_RESERVE,PAGE_READWRITE);DWORD recoveryAllocError=again?0:GetLastError();BOOL memRecovery=again!=NULL;
 if(again&&!VirtualFree(again,0,MEM_RELEASE)){DWORD e=GetLastError();freeOk=FALSE;if(!freeError)freeError=e;}
 /* Evidence completeness != proof that any refusal was caused by this job. */
 BOOL complete=self.creation&&first.creation&&recoveryId.creation&&baseline.ok&&beforeSlot.ok&&afterSlot.ok&&beforeBreak.ok&&afterBreak.ok&&afterRecovery.ok&&exitRead&&beforeMemoryOk&&peakOk&&memoryRead&&freeOk;
 emit("{\"schema\":\"enclave-disposable-job-probe/2\",\"probe\":");outid(self);emit(",\"firstChild\":");outid(first);emit(",\"unexpectedSlotChild\":");outid(unexpectedSlot);emit(",\"unexpectedBreakawayChild\":");outid(unexpectedBreak);emit(",\"recoveryChild\":");outid(recoveryId);
 emit(",\"limits\":{\"flags\":");number(lim.BasicLimitInformation.LimitFlags);emit(",\"jobCommitBytes\":");number(lim.JobMemoryLimit);emit(",\"activeProcessLimit\":");number(lim.BasicLimitInformation.ActiveProcessLimit);emit(",\"affinityMask\":");number(lim.BasicLimitInformation.Affinity);emit("}");
 emit(",\"baseline\":");outaccount(baseline);emit(",\"beforeSlot\":");outaccount(beforeSlot);emit(",\"afterSlot\":");outaccount(afterSlot);emit(",\"beforeBreakaway\":");outaccount(beforeBreak);emit(",\"afterBreakaway\":");outaccount(afterBreak);emit(",\"afterRecovery\":");outaccount(afterRecovery);
 emit(",\"slotAttempt\":{\"created\":");boolean(slotCreated);emit(",\"error\":");number(slotError);emit("},\"firstChildExitCode\":");number(childExit);
 emit(",\"breakawayAttempt\":{\"created\":");boolean(breakCreated);emit(",\"error\":");number(breakError);emit("},\"recoveryAttempt\":{\"created\":");boolean(recovered);emit(",\"error\":");number(recoveryError);emit(",\"memberOfAJob\":");boolean(recoveryMember);emit("}");
 emit(",\"memory\":{\"chunkBytes\":");number(CHUNK);emit(",\"allocatedBytes\":");number(used*CHUNK);emit(",\"refused\":");boolean(refused);emit(",\"allocationError\":");number(allocError);emit(",\"timedOut\":");boolean(timedOut);
 emit(",\"beforePeakJobCommitBytes\":");number(beforeMemory.PeakJobMemoryUsed);emit(",\"beforePeakQueryError\":");number(beforeMemoryError);emit(",\"peakJobCommitBytes\":");number(peak.PeakJobMemoryUsed);emit(",\"peakQueryError\":");number(peakError);
 emit(",\"availablePhysicalBefore\":");number(m.ullAvailPhys);emit(",\"availableCommitBefore\":");number(m.ullAvailPageFile);emit(",\"availablePhysicalAfter\":");number(afterMemory.ullAvailPhys);emit(",\"availableCommitAfter\":");number(afterMemory.ullAvailPageFile);emit(",\"systemMemoryQueryError\":");number(memoryReadError);
 emit(",\"freed\":");boolean(freeOk);emit(",\"freeError\":");number(freeError);emit(",\"allocationRecovered\":");boolean(memRecovery);emit(",\"recoveryError\":");number(recoveryAllocError);emit("}");
 emit(",\"evidenceCollected\":");boolean(complete);emit(",\"limitAttributionQualified\":false,\"ownerDeathQualified\":false,\"scopePassed\":false}\n");ExitProcess(complete?0:12);
}
