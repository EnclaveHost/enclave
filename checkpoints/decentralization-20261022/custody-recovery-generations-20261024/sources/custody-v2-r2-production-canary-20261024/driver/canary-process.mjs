// A canary guest gets ONE launch. The surrounding transient unit owns final cgroup cleanup.
// Unexpected child exit or spawn failure terminates the host; it never schedules a replacement VM.
export function watchCanaryGuest(child,{isStopping,exit=code=>process.exit(code),notify=()=>{}}){
 if(!child||typeof child.once!=='function'||typeof isStopping!=='function'||typeof exit!=='function')throw Error('canary child supervision configuration invalid');
 let terminal=false;
 const ended=()=>{
  if(terminal)return;terminal=true;
  if(isStopping())return;
  // No child-provided error, status or stdout is included. Even a normal guest exit requires explicit recovery.
  try{notify('Canary guest ended; explicit recovery required.');}finally{exit(71);}
 };
 child.once('error',ended);child.once('exit',ended);
 return {get terminal(){return terminal;}};
}
