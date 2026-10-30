/* Measured guest TPM transport selection. A builtin driver cannot be detected by
 * looking for a .ko file: silently omitting -vbs-tpm would downgrade the report
 * path. New desktop images carry the marker below in their measured initramfs.
 * This selects a required transport; the monitor/verifier still validate reports. */
#ifndef ENCLAVE_VTPM_BOOT_H
#define ENCLAVE_VTPM_BOOT_H
#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define ENCLAVE_VTPM_BUILTIN_MARKER "ENCLAVE-OPENHCL-TPM/1\n"
enum enclave_vtpm_boot { ENCLAVE_VTPM_ERROR = -1, ENCLAVE_VTPM_NONE = 0,
                         ENCLAVE_VTPM_MODULE = 1, ENCLAVE_VTPM_BUILTIN = 2 };

static int enclave_vtpm_file_present(const char *path, struct stat *st) {
    if (lstat(path, st) == 0) return 1;
    return errno == ENOENT ? 0 : -1;
}

static int enclave_vtpm_boot_mode(const char *marker, const char *module,
                                   int snp, int has_report_host, int required) {
    struct stat a, b;
    int builtin = enclave_vtpm_file_present(marker, &a);
    int loadable = enclave_vtpm_file_present(module, &b);
    if (builtin < 0 || loadable < 0 || (builtin && loadable)) return ENCLAVE_VTPM_ERROR;
    if (!builtin && !loadable) return required ? ENCLAVE_VTPM_ERROR : ENCLAVE_VTPM_NONE;
    if (snp || !has_report_host) return ENCLAVE_VTPM_ERROR;
    if (loadable) {
        if (!S_ISREG(b.st_mode) || b.st_uid != 0 || (b.st_mode & 0022)) return ENCLAVE_VTPM_ERROR;
        return ENCLAVE_VTPM_MODULE;
    }
    if (!S_ISREG(a.st_mode) || a.st_uid != 0 || (a.st_mode & 0022)) return ENCLAVE_VTPM_ERROR;
    int fd = open(marker, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return ENCLAVE_VTPM_ERROR;
    char value[sizeof ENCLAVE_VTPM_BUILTIN_MARKER];
    size_t used = 0;
    while (used < sizeof value) {
        ssize_t n = read(fd, value + used, sizeof value - used);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) { close(fd); return ENCLAVE_VTPM_ERROR; }
        if (!n) break;
        used += (size_t)n;
    }
    close(fd);
    if (used != sizeof ENCLAVE_VTPM_BUILTIN_MARKER - 1 ||
        memcmp(value, ENCLAVE_VTPM_BUILTIN_MARKER, used)) return ENCLAVE_VTPM_ERROR;
    return ENCLAVE_VTPM_BUILTIN;
}

static int enclave_vtpm_device_ready(const char *path) {
    struct stat st;
    return lstat(path, &st) == 0 && S_ISCHR(st.st_mode) && st.st_uid == 0 &&
           !(st.st_mode & 0077) && access(path, R_OK | W_OK) == 0;
}
#endif
