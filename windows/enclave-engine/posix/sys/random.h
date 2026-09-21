#ifndef EE_SYS_RANDOM_H
#define EE_SYS_RANDOM_H
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
#ifndef _SSIZE_T_DEFINED
typedef ptrdiff_t ssize_t;
#define _SSIZE_T_DEFINED 1
#endif
ssize_t getrandom(void *p, size_t n, unsigned flags);
#ifdef __cplusplus
}
#endif
#endif
