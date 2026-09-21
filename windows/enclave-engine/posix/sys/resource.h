#ifndef EE_SYS_RESOURCE_H
#define EE_SYS_RESOURCE_H
#ifdef __cplusplus
extern "C" {
#endif
struct rlimit { unsigned long long rlim_cur, rlim_max; };
#define RLIMIT_MEMLOCK 8
#define RLIM_INFINITY (~0ull)
struct ee_timeval_ru { long tv_sec, tv_usec; };
struct rusage { struct ee_timeval_ru ru_utime, ru_stime; long ru_maxrss, ru_ixrss, ru_idrss, ru_isrss, ru_minflt, ru_majflt, ru_nswap, ru_inblock, ru_oublock, ru_msgsnd, ru_msgrcv, ru_nsignals, ru_nvcsw, ru_nivcsw; };
#define RUSAGE_SELF 0
#define RUSAGE_THREAD 1
int getrusage(int who, struct rusage *u);
int getrlimit(int r, struct rlimit *l); int setrlimit(int r, const struct rlimit *l);
#ifdef __cplusplus
}
#endif
#endif
