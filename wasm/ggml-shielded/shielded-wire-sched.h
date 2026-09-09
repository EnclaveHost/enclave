/* Opt-in guest scheduling attribution. No payload bytes. Counter reads are
 * outside the reported WS phase, and their wall cost is reported separately.
 * schedstat runqueue delay is distinct from time blocked in a socket read.
 * Counter snapshot boundaries are uncertain within the two observer windows. */
#ifndef SHIELDED_WIRE_SCHED_H
#define SHIELDED_WIRE_SCHED_H
#include <errno.h>
#include <fcntl.h>
#include <sys/resource.h>

typedef struct {
    uint64_t before, after, cpu_before, cpu_after, runq;
    long voluntary, involuntary, minor_faults, major_faults;
    int sched_error, usage_error;
} sh_ws_stamp;
typedef struct {
    sh_ws_stamp start, end;
    uint64_t call;
    unsigned tid, ready;
    const char *tag;
} sh_ws_row;
#ifndef SH_WS_CAP
#define SH_WS_CAP 16384u
#endif
static sh_ws_row sh_ws_rows[SH_WS_CAP];
static unsigned sh_ws_count, sh_ws_dumped;
static int sh_ws_on;
static pthread_once_t sh_ws_once = PTHREAD_ONCE_INIT;
static void sh_ws_init(void) {
    const char *e=getenv("SHIELDED_WIRE_SCHED");
    sh_ws_on=e && !strcmp(e,"1");
}
static int sh_ws_enabled(void) { pthread_once(&sh_ws_once,sh_ws_init);return sh_ws_on; }
static int sh_ws_parse(const char *p,uint64_t *runq) {
    uint64_t v[3];
    for (int i=0;i<3;i++) {
        while (*p==' ' || *p=='\t') ++p;
        if (*p<'0' || *p>'9') return EINVAL;
        char *end;errno=0;unsigned long long n=strtoull(p,&end,10);
        if (errno==ERANGE) return ERANGE;
        v[i]=(uint64_t)n;p=end;
        if (i<2 && *p!=' ' && *p!='\t') return EINVAL;
    }
    while (*p==' ' || *p=='\t' || *p=='\n') ++p;
    if (*p) return EINVAL;
    *runq=v[1];return 0;
}
static sh_ws_stamp sh_ws_now(int profile) {
    sh_ws_stamp s={0};
    if (!profile || !sh_ws_enabled()) return s;
    const int saved=errno;
    s.before=sh_sp_ns(CLOCK_MONOTONIC);s.cpu_before=sh_sp_ns(CLOCK_THREAD_CPUTIME_ID);
    int fd=open("/proc/thread-self/schedstat",O_RDONLY|O_CLOEXEC);
    if (fd<0) s.sched_error=errno;
    else {
        char buf[128];ssize_t n;
        do { n=read(fd,buf,sizeof buf-1); } while (n<0 && errno==EINTR);
        if (n<0) s.sched_error=errno;
        else if (n==0 || n==(ssize_t)sizeof buf-1) s.sched_error=EOVERFLOW;
        else { buf[n]=0;s.sched_error=sh_ws_parse(buf,&s.runq); }
        close(fd);
    }
    struct rusage u;
    if (getrusage(RUSAGE_THREAD,&u)) s.usage_error=errno;
    else {
        s.voluntary=u.ru_nvcsw;s.involuntary=u.ru_nivcsw;
        s.minor_faults=u.ru_minflt;s.major_faults=u.ru_majflt;
    }
    s.cpu_after=sh_sp_ns(CLOCK_THREAD_CPUTIME_ID);s.after=sh_sp_ns(CLOCK_MONOTONIC);
    errno=saved;return s;
}
static void sh_ws_end(sh_ws_stamp start,const char *tag,uint64_t call) {
    if (!start.before) return;
    sh_ws_stamp end=sh_ws_now(1);
    unsigned n=__atomic_fetch_add(&sh_ws_count,1u,__ATOMIC_RELAXED);
    if (n>=SH_WS_CAP) return;
    sh_ws_row *r=&sh_ws_rows[n];r->start=start;r->end=end;r->tag=tag;r->call=call;
    r->tid=(unsigned)syscall(SYS_gettid);
    __atomic_store_n(&r->ready,1u,__ATOMIC_RELEASE);
}
static int sh_ws_fault_delta(const sh_ws_stamp *a,const sh_ws_stamp *b,long *minor,long *major) {
    *minor=*major=0;
    if(a->usage_error || b->usage_error)return a->usage_error?a->usage_error:b->usage_error;
    if(a->minor_faults<0 || a->major_faults<0 || b->minor_faults<a->minor_faults || b->major_faults<a->major_faults)return ERANGE;
    *minor=b->minor_faults-a->minor_faults;*major=b->major_faults-a->major_faults;
    return 0;
}
static void sh_ws_dump(void) {
    if (!sh_ws_enabled()) return;
    unsigned n=__atomic_load_n(&sh_ws_count,__ATOMIC_ACQUIRE),cap=n<SH_WS_CAP?n:SH_WS_CAP;
    while (sh_ws_dumped<cap) {
        const sh_ws_row *r=&sh_ws_rows[sh_ws_dumped];
        if (!__atomic_load_n(&r->ready,__ATOMIC_ACQUIRE)) break;
        const sh_ws_stamp *a=&r->start,*b=&r->end;
        int se=a->sched_error?a->sched_error:b->sched_error,ue=a->usage_error?a->usage_error:b->usage_error;
        if (!se && b->runq<a->runq) se=ERANGE;
        if (!ue && (b->voluntary<a->voluntary || b->involuntary<a->involuntary)) ue=ERANGE;
        fprintf(stderr,"WS %s %u %llu %llu %llu %llu %llu %llu %llu %ld %ld %d %d\n",r->tag,r->tid,
            (unsigned long long)r->call,(unsigned long long)a->after,
            (unsigned long long)(b->before-a->after),(unsigned long long)(b->cpu_before-a->cpu_after),
            (unsigned long long)(se?0:b->runq-a->runq),(unsigned long long)(a->after-a->before),
            (unsigned long long)(b->after-b->before),ue?0:b->voluntary-a->voluntary,ue?0:b->involuntary-a->involuntary,se,ue);
        long minor,major;int fe=sh_ws_fault_delta(a,b,&minor,&major);
        fprintf(stderr,"WF %s %u %llu %ld %ld %d\n",r->tag,r->tid,(unsigned long long)r->call,minor,major,fe);
        ++sh_ws_dumped;
    }
    fprintf(stderr,"WS_COUNT recorded=%u dumped=%u dropped=%u\n",cap,sh_ws_dumped,n-cap);
}
#endif
