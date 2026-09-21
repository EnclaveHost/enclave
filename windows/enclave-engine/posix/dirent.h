#ifndef EE_DIRENT_H
#define EE_DIRENT_H
#ifdef __cplusplus
extern "C" {
#endif
typedef struct ee_DIR DIR;
struct dirent { unsigned long d_ino; unsigned char d_type; char d_name[256]; };
#define DT_REG 8
#define DT_DIR 4
DIR *opendir(const char *p); struct dirent *readdir(DIR *d); int closedir(DIR *d);
#ifdef __cplusplus
}
#endif
#endif
