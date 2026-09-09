/* Default-off, deferred syscall aggregates. No bytes or secrets are logged.
 * Requires FIELD source profiling as well as SHIELDED_RECV_PROFILE=1.
 * Clocks include boundary overhead; the outer WS observer remains independent. */
#ifndef SHIELDED_RECV_PROFILE_H
#define SHIELDED_RECV_PROFILE_H
#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>
enum { SH_RP_GET, SH_RP_SET, SH_RP_POLL, SH_RP_RECV, SH_RP_RESTORE, SH_RP_READ, SH_RP_OPS };
typedef struct {
    uint64_t count,wall,cpu,peak_wall,peak_wall_cpu,peak_wall_start,peak_cpu;
    uint64_t bytes,errors,eintr,eagain,zero;
} sh_rp_op;
typedef struct {
    uint64_t call,requested,clock_errors,cpu_over_wall,poll_flags;
    unsigned tid,ready; int cap,result,final_errno;
    const char *kind;
    sh_rp_op op[SH_RP_OPS];
} sh_rp_row;
typedef struct { uint64_t wall,cpu; int valid; } sh_rp_stamp;
#ifndef SH_RP_CAP
#define SH_RP_CAP 8192u
#endif
static sh_rp_row sh_rp_rows[SH_RP_CAP];
static uint64_t sh_rp_count,sh_rp_dumped;
static pthread_once_t sh_rp_once=PTHREAD_ONCE_INIT;
static int sh_rp_on;
static void sh_rp_init(void) {
    const char *e=getenv("SHIELDED_RECV_PROFILE");sh_rp_on=e && !strcmp(e,"1");
}
static sh_rp_row *sh_rp_new(int profile,uint64_t call,const char *kind,size_t requested,int cap) {
    if(!profile)return NULL;
    const int saved=errno;
    pthread_once(&sh_rp_once,sh_rp_init);
    sh_rp_row *r=NULL;
    if(sh_rp_on) {
        uint64_t n=__atomic_fetch_add(&sh_rp_count,1,__ATOMIC_RELAXED);
        if(n<SH_RP_CAP) {
            r=&sh_rp_rows[n];r->call=call;r->kind=kind;r->requested=requested;r->cap=cap;
            r->tid=(unsigned)syscall(SYS_gettid);
        }
    }
    errno=saved;return r;
}
static sh_rp_stamp sh_rp_now(sh_rp_row *r) {
    sh_rp_stamp s={0};if(!r)return s;
    const int saved=errno;struct timespec w={0},c={0};
    const int ew=clock_gettime(CLOCK_MONOTONIC,&w),ec=clock_gettime(CLOCK_THREAD_CPUTIME_ID,&c);
    if(ew || ec || w.tv_sec<0 || c.tv_sec<0)r->clock_errors++;
    else {s.wall=(uint64_t)w.tv_sec*1000000000+(uint64_t)w.tv_nsec;s.cpu=(uint64_t)c.tv_sec*1000000000+(uint64_t)c.tv_nsec;s.valid=1;}
    errno=saved;return s;
}
static void sh_rp_end(sh_rp_row *r,int op,sh_rp_stamp start,int64_t result) {
    if(!r)return;
    const int saved=errno;sh_rp_stamp end=sh_rp_now(r);sh_rp_op *v=&r->op[op];v->count++;
    if(start.valid && end.valid && end.wall>=start.wall && end.cpu>=start.cpu) {
        const uint64_t wall=end.wall-start.wall,cpu=end.cpu-start.cpu;
        v->wall+=wall;v->cpu+=cpu;
        if(wall>v->peak_wall){v->peak_wall=wall;v->peak_wall_cpu=cpu;v->peak_wall_start=start.wall;}
        if(cpu>v->peak_cpu)v->peak_cpu=cpu;
        if(cpu>wall)r->cpu_over_wall+=cpu-wall;
    } else r->clock_errors++;
    if(result<0){v->errors++;if(saved==EINTR)v->eintr++;if(saved==EAGAIN || saved==EWOULDBLOCK)v->eagain++;}
    if(result==0)v->zero++;
    if(result>0 && (op==SH_RP_RECV || op==SH_RP_READ))v->bytes+=(uint64_t)result;
    errno=saved;
}
static void sh_rp_finish(sh_rp_row *r,int result) {
    if(!r)return;
    r->result=result;r->final_errno=errno;
    __atomic_store_n(&r->ready,1u,__ATOMIC_RELEASE);
}
static void sh_rp_dump(void) {
    const int saved=errno;
    pthread_once(&sh_rp_once,sh_rp_init);
    if(!sh_rp_on){errno=saved;return;}
    static const char *names[]={"get","set","poll","recv","restore","read"};
    const uint64_t n=__atomic_load_n(&sh_rp_count,__ATOMIC_ACQUIRE),cap=n<SH_RP_CAP?n:SH_RP_CAP;
    while(sh_rp_dumped<cap) {
        const sh_rp_row *r=&sh_rp_rows[sh_rp_dumped];
        if(!__atomic_load_n(&r->ready,__ATOMIC_ACQUIRE))break;
        fprintf(stderr,"RP_READ %s %u %llu %llu %d %d %d %llu %llu %llu\n",r->kind,r->tid,
            (unsigned long long)r->call,(unsigned long long)r->requested,r->cap,r->result,r->final_errno,
            (unsigned long long)r->clock_errors,(unsigned long long)r->cpu_over_wall,(unsigned long long)r->poll_flags);
        for(int i=0;i<SH_RP_OPS;i++) {
            const sh_rp_op *v=&r->op[i];
            fprintf(stderr,"RP_OP %s %u %llu %s %llu %llu %llu %llu %llu %llu %llu %llu %llu %llu %llu %llu\n",
                r->kind,r->tid,(unsigned long long)r->call,names[i],
                (unsigned long long)v->count,(unsigned long long)v->wall,(unsigned long long)v->cpu,
                (unsigned long long)v->peak_wall,(unsigned long long)v->peak_wall_cpu,(unsigned long long)v->peak_wall_start,
                (unsigned long long)v->peak_cpu,(unsigned long long)v->bytes,(unsigned long long)v->errors,
                (unsigned long long)v->eintr,(unsigned long long)v->eagain,(unsigned long long)v->zero);
        }
        sh_rp_dumped++;
    }
    fprintf(stderr,"RP_COUNT recorded=%llu dumped=%llu dropped=%llu\n",(unsigned long long)cap,(unsigned long long)sh_rp_dumped,(unsigned long long)(n-cap));
    errno=saved;
}
#endif
