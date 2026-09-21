#ifndef EE_SYS_TIME_H
#define EE_SYS_TIME_H
#include <time.h>
#ifdef __cplusplus
extern "C" {
#endif
struct timeval { long tv_sec, tv_usec; };
int gettimeofday(struct timeval *tv, void *tz);
#ifdef __cplusplus
}
#endif
#endif
