#ifndef EE_SYS_SYSCALL_H
#define EE_SYS_SYSCALL_H
#define SYS_gettid 186
#ifdef __cplusplus
extern "C" {
#endif
long syscall(long n, ...);
#ifdef __cplusplus
}
#endif
#endif
