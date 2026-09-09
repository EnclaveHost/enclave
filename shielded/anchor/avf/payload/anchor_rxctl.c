#include "anchor_rxctl.h"
#include <errno.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>
/* g.cv is zero storage and initialised exactly ONCE (pthread_once) with a CLOCK_MONOTONIC condattr: the deadline below is
 * monotonic, and a default-initialised condvar waits on CLOCK_REALTIME (a monotonic deadline would look already expired). */
static pthread_cond_t g_cv;                                           /* zero storage: initialised exactly once below, never by an INITIALIZER */
static struct { pthread_mutex_t mu; int stop, active_fd, exited, cv_ok; } g = { PTHREAD_MUTEX_INITIALIZER, 0, -1, 0, 0 };
static pthread_once_t g_once = PTHREAD_ONCE_INIT;
static void cv_init(void) {
    pthread_condattr_t at;
    if (pthread_condattr_init(&at) != 0) return;                     /* no attr: no condvar; quiesce falls back to polling the flag */
    if (pthread_condattr_setclock(&at, CLOCK_MONOTONIC) == 0 && pthread_cond_init(&g_cv, &at) == 0) g.cv_ok = 1;
    pthread_condattr_destroy(&at);                                    /* only after a successful condattr_init */
}
void anchor_rx_reset(void) { pthread_once(&g_once, cv_init); pthread_mutex_lock(&g.mu); g.stop = 0; g.active_fd = -1; g.exited = 0; pthread_mutex_unlock(&g.mu); }
int  anchor_rx_should_stop(void) { pthread_mutex_lock(&g.mu); const int s = g.stop; pthread_mutex_unlock(&g.mu); return s; }
int  anchor_rx_set_active(int fd) {
    pthread_mutex_lock(&g.mu);
    if (g.stop) { pthread_mutex_unlock(&g.mu); if (fd >= 0) shutdown(fd, SHUT_RDWR); return 0; }   /* the stop landed between the loop's check and this accept: refused, never read */
    g.active_fd = fd; pthread_mutex_unlock(&g.mu); return 1;
}
void anchor_rx_close(int fd) {
    pthread_mutex_lock(&g.mu); if (g.active_fd == fd) g.active_fd = -1; pthread_mutex_unlock(&g.mu);   /* unregistered BEFORE the number can be reused */
    if (fd >= 0) close(fd);
}
void anchor_rx_exited(void) { pthread_mutex_lock(&g.mu); g.exited = 1; if (g.cv_ok) pthread_cond_broadcast(&g_cv); pthread_mutex_unlock(&g.mu); }
static int past(const struct timespec *dl) { struct timespec now; clock_gettime(CLOCK_MONOTONIC, &now); return now.tv_sec > dl->tv_sec || (now.tv_sec == dl->tv_sec && now.tv_nsec >= dl->tv_nsec); }
int anchor_rx_quiesce(pthread_t th, unsigned wait_ms) {
    pthread_once(&g_once, cv_init);
    struct timespec dl; clock_gettime(CLOCK_MONOTONIC, &dl);
    dl.tv_sec += wait_ms / 1000u; dl.tv_nsec += (long)(wait_ms % 1000u) * 1000000L; if (dl.tv_nsec >= 1000000000L) { dl.tv_sec++; dl.tv_nsec -= 1000000000L; }
    pthread_mutex_lock(&g.mu);
    g.stop = 1;
    if (g.active_fd >= 0) shutdown(g.active_fd, SHUT_RDWR);          /* still registered = still open: a blocked read wakes, the reception is refused (SIGPIPE must be ignored by the process) */
    while (!g.exited && !past(&dl)) {
        if (g.cv_ok) { const int rc = pthread_cond_timedwait(&g_cv, &g.mu, &dl); if (rc != 0 && rc != ETIMEDOUT) break; }   /* any other error: give up rather than spin under the lock */
        else { pthread_mutex_unlock(&g.mu); usleep(20000); pthread_mutex_lock(&g.mu); }                                     /* no condvar: poll the flag on the same deadline */
    }
    const int ok = g.exited;
    pthread_mutex_unlock(&g.mu);
    if (ok) pthread_join(th, NULL);                                   /* exited: the join returns at once */
    return ok;
}
