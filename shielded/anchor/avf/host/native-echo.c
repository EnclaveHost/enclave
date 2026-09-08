/* Diagnostic echo only. This does not forward inference traffic or alter the
 * descriptor's flags/ownership. Same 64 KiB buffer as the Java echo loop. */
#define _GNU_SOURCE
#include <errno.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/socket.h>
#include <time.h>

static int64_t echo_now_ms(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts)) return -1;
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}
static int echo_wait(int fd, short events, int64_t deadline) {
    for (;;) {
        const int64_t now = echo_now_ms();
        if (now < 0) return -EIO;
        if (now >= deadline) return -ETIMEDOUT;
        struct pollfd p = {fd, events, 0};
        int n = poll(&p, 1, (int)(deadline - now));
        if (n > 0) return p.revents & POLLNVAL ? -EBADF : 0;
        if (n == 0) return -ETIMEDOUT;
        if (errno != EINTR) return -errno;
    }
}
static int64_t anchor_native_echo(int fd, int timeout_ms) {
    if (fd < 0 || timeout_ms < 1 || timeout_ms > 600000) return -EINVAL;
    int64_t now = echo_now_ms(); if (now < 0) return -EIO;
    const int64_t deadline = now + timeout_ms;
    int64_t total = 0; unsigned char buffer[65536];
    for (;;) {
        now = echo_now_ms(); if (now < 0) return -EIO;
        if (now >= deadline) return -ETIMEDOUT;
        ssize_t n = recv(fd, buffer, sizeof buffer, MSG_DONTWAIT);
        if (n == 0) return total;
        if (n < 0) {
            if (errno == EINTR) continue;
            if (errno != EAGAIN && errno != EWOULDBLOCK) return -errno;
            int rc = echo_wait(fd, POLLIN, deadline); if (rc) return rc;
            continue;
        }
        size_t offset = 0;
        while (offset < (size_t)n) {
            now = echo_now_ms(); if (now < 0) return -EIO;
            if (now >= deadline) return -ETIMEDOUT;
            ssize_t sent = send(fd, buffer + offset, (size_t)n - offset, MSG_DONTWAIT | MSG_NOSIGNAL);
            if (sent > 0) { offset += (size_t)sent; continue; }
            if (sent == 0) return -EIO;
            if (errno == EINTR) continue;
            if (errno != EAGAIN && errno != EWOULDBLOCK) return -errno;
            int rc = echo_wait(fd, POLLOUT, deadline); if (rc) return rc;
        }
        total += n;
    }
}

#ifdef __ANDROID__
#include <jni.h>
JNIEXPORT jlong JNICALL Java_host_enclave_anchor_avf_NativeEcho_run(JNIEnv *env, jclass klass, jint fd) {
    (void)env; (void)klass;
    return (jlong)anchor_native_echo(fd, 600000);
}
JNIEXPORT jstring JNICALL Java_host_enclave_anchor_avf_NativeEcho_describe(JNIEnv *env, jclass klass, jint fd) {
    (void)klass;
    int domain=-1,type=-1,send_bytes=-1,receive_bytes=-1; socklen_t size=sizeof(int);
    (void)getsockopt(fd,SOL_SOCKET,SO_DOMAIN,&domain,&size); size=sizeof(int);
    (void)getsockopt(fd,SOL_SOCKET,SO_TYPE,&type,&size); size=sizeof(int);
    (void)getsockopt(fd,SOL_SOCKET,SO_SNDBUF,&send_bytes,&size); size=sizeof(int);
    (void)getsockopt(fd,SOL_SOCKET,SO_RCVBUF,&receive_bytes,&size);
    char message[160];
    snprintf(message,sizeof message,"domain=%d type=%d sndbuf=%d rcvbuf=%d",domain,type,send_bytes,receive_bytes);
    return (*env)->NewStringUTF(env,message);
}
#endif
