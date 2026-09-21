/* posix/pthread.h -- pthreads for the enclave, over SRW locks, condition variables and host-entered threads (ee-rt.c). */
#ifndef EE_PTHREAD_H
#define EE_PTHREAD_H
#include <stddef.h>
#include <time.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct ee_pthread_mutex { void *srw; } pthread_mutex_t;
typedef struct ee_pthread_cond { void *cv; } pthread_cond_t;
typedef void *pthread_t;
typedef int pthread_mutexattr_t, pthread_condattr_t, pthread_attr_t;
#define PTHREAD_MUTEX_INITIALIZER { 0 }
#define PTHREAD_COND_INITIALIZER { 0 }
int pthread_mutex_init(pthread_mutex_t *, const pthread_mutexattr_t *); int pthread_mutex_destroy(pthread_mutex_t *);
int pthread_mutex_lock(pthread_mutex_t *); int pthread_mutex_unlock(pthread_mutex_t *); int pthread_mutex_trylock(pthread_mutex_t *);
int pthread_cond_init(pthread_cond_t *, const pthread_condattr_t *); int pthread_cond_destroy(pthread_cond_t *);
int pthread_cond_wait(pthread_cond_t *, pthread_mutex_t *); int pthread_cond_timedwait(pthread_cond_t *, pthread_mutex_t *, const struct timespec *);
int pthread_cond_signal(pthread_cond_t *); int pthread_cond_broadcast(pthread_cond_t *);
int pthread_create(pthread_t *, const pthread_attr_t *, void *(*)(void *), void *); int pthread_join(pthread_t, void **); int pthread_detach(pthread_t);
pthread_t pthread_self(void); int pthread_setname_np(pthread_t, const char *);
int pthread_attr_init(pthread_attr_t *); int pthread_attr_destroy(pthread_attr_t *); int pthread_attr_setstacksize(pthread_attr_t *, size_t);
typedef long pthread_once_t;
#define PTHREAD_ONCE_INIT 0
int pthread_once(pthread_once_t *once, void (*init)(void));
int sched_yield(void);
#ifdef __cplusplus
}
#endif
#endif
