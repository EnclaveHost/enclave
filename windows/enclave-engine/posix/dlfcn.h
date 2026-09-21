#ifndef EE_DLFCN_H
#define EE_DLFCN_H
#ifdef __cplusplus
extern "C" {
#endif
#define RTLD_NOW 2
#define RTLD_GLOBAL 0x100
#define RTLD_LOCAL 0
#define RTLD_DEFAULT ((void *)0)
void *dlopen(const char *p, int f); void *dlsym(void *h, const char *s); int dlclose(void *h); char *dlerror(void);
#ifdef __cplusplus
}
#endif
#endif
