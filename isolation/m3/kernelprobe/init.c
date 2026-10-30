/* Isolated hardware diagnostic only. No desktop, app loading, keys or network.
 * Do not put this executable in a production initramfs. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/uinput.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/reboot.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/utsname.h>
#include <sys/wait.h>
#include <unistd.h>
#include "../vtpm-boot.h"
#include "../../m2/app-seccomp.h"

static void fail(const char *what) {
    printf("KVMBOX_KERNEL_PROBE FAIL %s errno=%d\n", what, errno);
    fflush(stdout);
    sync(); reboot(RB_POWER_OFF);
    _exit(1);
}
static void required_mount(const char *type, const char *where) {
    if (mount(type, where, type, 0, NULL) != 0) fail(where);
}
static void input_device(const char *path) {
    struct stat st;
    if (lstat(path, &st) || !S_ISCHR(st.st_mode) || chown(path, 1000, 1000) || chmod(path, 0660)) fail(path);
}
static void child_check(void) {
    if (setgroups(0, NULL) || setgid(1000) || setuid(1000) || getuid() != 1000 || geteuid() != 1000) _exit(11);
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || app_seccomp_install()) _exit(12);
    char statement[128];
    if (app_seccomp_statement(statement, sizeof statement) < 0) _exit(18);
    printf("KVMBOX_KERNEL_PROBE %s", statement);
    errno = 0;
    int t = open("/dev/tpm0", O_RDWR | O_CLOEXEC);
    if (t >= 0 || errno != EACCES) _exit(13);
    int u = open("/dev/uinput", O_RDWR | O_NONBLOCK | O_CLOEXEC);
    int h = open("/dev/uhid", O_RDWR | O_NONBLOCK | O_CLOEXEC);
    if (u < 0 || h < 0) _exit(14);
    unsigned version = 0;
    if (ioctl(u, UI_GET_VERSION, &version) || version < 5) _exit(15);
    close(u); close(h);
    errno = 0;
    if (socket(AF_VSOCK, SOCK_STREAM, 0) >= 0 || errno != EPERM) _exit(16);
    errno = 0;
    if (syscall(APP_NR_io_uring_setup, 0, NULL) >= 0 || errno != EPERM) _exit(17);
    printf("KVMBOX_KERNEL_PROBE uid=1000 tpm=denied input=available uinput_version=%u vsock=denied io_uring=denied\n", version);
    fflush(stdout);
    _exit(0);
}
int main(void) {
    struct utsname kernel;
    if (getpid() != 1 || getuid() != 0 || uname(&kernel) || strcmp(kernel.release, "6.6.87.2-enclave-kvm-box")) return 64;
    required_mount("devtmpfs", "/dev");
    int con = open("/dev/console", O_RDWR);
    if (con < 0 || dup2(con, 0) < 0 || dup2(con, 1) < 0 || dup2(con, 2) < 0) return 1;
    if (con > 2) close(con);
    setvbuf(stdout, NULL, _IOLBF, 0);
    required_mount("proc", "/proc");
    required_mount("sysfs", "/sys");
    required_mount("tmpfs", "/tmp");
    required_mount("configfs", "/sys/kernel/config");
    required_mount("cgroup2", "/sys/fs/cgroup");
    if (enclave_vtpm_boot_mode("/enclave_openhcl_tpm.builtin", "/enclave_openhcl_tpm.ko", 0, 1, 1) != ENCLAVE_VTPM_BUILTIN ||
        !enclave_vtpm_device_ready("/dev/tpm0")) fail("required builtin TPM");
    input_device("/dev/uinput"); input_device("/dev/uhid");
    pid_t p = fork();
    if (p < 0) fail("fork device check");
    if (!p) child_check();
    int status;
    if (waitpid(p, &status, 0) != p || !WIFEXITED(status) || WEXITSTATUS(status)) fail("unprivileged device checks");
    p = fork();
    if (p < 0) fail("fork report check");
    if (!p) {
        char *args[] = {"/report", NULL}; char *env[] = {NULL};
        execve(args[0], args, env); _exit(127);
    }
    if (waitpid(p, &status, 0) != p || !WIFEXITED(status) || WEXITSTATUS(status)) fail("TPM report checks");
    printf("KVMBOX_KERNEL_PROBE PASS kernel=%s scope=kernel-devices-and-fresh-bindings-only\n", kernel.release);
    sleep(15);
    sync(); reboot(RB_POWER_OFF);
    return 0;
}
