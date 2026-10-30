/* TEST LAUNCHER ONLY. Not production manager code. No CRT or shell command parsing.
 * Own unnamed Job Object includes launcher, PowerShell and sequential Node children.
 * Hard aggregate COMMIT 256 MiB; not an RSS guarantee. CPU affinity 1, four processes,
 * no breakaway, kill-on-close. Stop the owned job on pressure or 30-second deadline.
 * This source/build is not Windows Job Object qualification. No remote execution here.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#define CAP_BYTES (256ULL*1024ULL*1024ULL)
#define FLOOR_BYTES (17ULL*1024ULL*1024ULL*1024ULL)
static WCHAR exe[MAX_PATH], command[4096], encoded[2049];
static JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
static STARTUPINFOW si;
static PROCESS_INFORMATION pi;
static MEMORYSTATUSEX memory;
static HANDLE job;
static unsigned length(const WCHAR *s){unsigned n=0;while(s[n])n++;return n;}
static BOOL append(WCHAR *dst,unsigned cap,const WCHAR *s){unsigned d=length(dst),n=length(s);if(d+n>=cap)return FALSE;for(unsigned i=0;i<=n;i++)dst[d+i]=s[i];return TRUE;}
static BOOL pressure_ok(void){memory.dwLength=sizeof(memory);return GlobalMemoryStatusEx(&memory)&&memory.ullAvailPhys>=FLOOR_BYTES&&memory.ullAvailPageFile>=CAP_BYTES;}
static void finish(UINT code){if(job)TerminateJobObject(job,code);ExitProcess(code);}
void WINAPI entry(void){
 const WCHAR *p=GetCommandLineW();unsigned n=0;
 /* Accept exactly one unquoted Base64 argument, after standard quoted/unquoted executable. */
 if(*p==L'"'){p++;while(*p&&*p!=L'"')p++;if(*p!=L'"')ExitProcess(90);p++;}
 else{while(*p&&*p!=L' '&&*p!=L'\t')p++;}
 while(*p==L' '||*p==L'\t')p++;
 while(*p&&*p!=L' '&&*p!=L'\t'){
  WCHAR c=*p++;if(n>=2048||!((c>=L'A'&&c<=L'Z')||(c>=L'a'&&c<=L'z')||(c>=L'0'&&c<=L'9')||c==L'+'||c==L'/'||c==L'='))ExitProcess(91);encoded[n++]=c;
 }
 while(*p==L' '||*p==L'\t')p++;if(*p||!n)ExitProcess(91);encoded[n]=0;
 UINT count=GetSystemDirectoryW(exe,MAX_PATH);if(!count||count>=MAX_PATH)ExitProcess(92);
 if(!append(exe,MAX_PATH,L"\\WindowsPowerShell\\v1.0\\powershell.exe"))ExitProcess(92);
 if(!append(command,4096,L"\"")||!append(command,4096,exe)||!append(command,4096,L"\" -NoProfile -NonInteractive -EncodedCommand ")||!append(command,4096,encoded))ExitProcess(93);
 if(!pressure_ok())ExitProcess(89);
 job=CreateJobObjectW(NULL,NULL);if(!job)ExitProcess(94);
 limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_JOB_MEMORY|JOB_OBJECT_LIMIT_ACTIVE_PROCESS|JOB_OBJECT_LIMIT_AFFINITY|JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
 limits.BasicLimitInformation.ActiveProcessLimit=4;limits.BasicLimitInformation.Affinity=1;limits.JobMemoryLimit=CAP_BYTES;
 if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits)))finish(95);
 if(!AssignProcessToJobObject(job,GetCurrentProcess()))finish(96);
 /* Nothing is launched until self/limits are installed; children inherit this non-breakaway job. */
 if(!pressure_ok())finish(89);
 si.cb=sizeof(si);si.dwFlags=STARTF_USESTDHANDLES;si.hStdInput=GetStdHandle(STD_INPUT_HANDLE);si.hStdOutput=GetStdHandle(STD_OUTPUT_HANDLE);si.hStdError=GetStdHandle(STD_ERROR_HANDLE);
 if(!CreateProcessW(exe,command,NULL,NULL,TRUE,CREATE_SUSPENDED|CREATE_NO_WINDOW,NULL,NULL,&si,&pi))finish(97);
 BOOL member=FALSE;if(!IsProcessInJob(pi.hProcess,job,&member)||!member){TerminateProcess(pi.hProcess,98);finish(98);}
 if(!pressure_ok()){TerminateProcess(pi.hProcess,89);finish(89);}
 if(ResumeThread(pi.hThread)==(DWORD)-1){TerminateProcess(pi.hProcess,98);finish(98);}CloseHandle(pi.hThread);
 ULONGLONG start=GetTickCount64();
 for(;;){
  DWORD wait=WaitForSingleObject(pi.hProcess,50);
  if(wait==WAIT_OBJECT_0){DWORD code=99;GetExitCodeProcess(pi.hProcess,&code);CloseHandle(pi.hProcess);finish(code);}
  if(wait!=WAIT_TIMEOUT)finish(99);
  if(!pressure_ok())finish(89);
  if(GetTickCount64()-start>=30000)finish(124);
 }
}
