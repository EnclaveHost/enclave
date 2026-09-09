/* Opt-in metadata-only bridge IO timeline. One owning thread; no file writes
 * during pumping. A bounded RAM array is exported after the bridge stops. */
#ifndef ANCHOR_BRIDGE_IO_H
#define ANCHOR_BRIDGE_IO_H
#include <stddef.h>
#include <sys/stat.h>

#ifndef ANCHOR_IO_MAX
#define ANCHOR_IO_MAX 131072
#endif
typedef struct {
    uint64_t start_ns, end_ns, offset;
    int64_t result;                  /* bytes, EOF=0, or negative errno */
    uint32_t kind, reserved;         /* 1 guest read, 2 TCP read, 3 TCP send, 4 guest send */
} anchor_io_event;
typedef struct {
    char magic[8];                   /* ABIO0001; little-endian fields */
    uint64_t count, dropped, bytes[4];
    int64_t bridge_status;
    uint64_t complete;
} anchor_io_header;
_Static_assert(sizeof(anchor_io_event)==40, "bridge IO event layout");
_Static_assert(sizeof(anchor_io_header)==72, "bridge IO header layout");
typedef struct {
    anchor_io_event *events;
    anchor_io_header header;
    int fd, error;
    uint64_t file_bytes;
} anchor_io_trace;

static void anchor_io_init(anchor_io_trace *t, int fd) {
    memset(t,0,sizeof *t);t->fd=fd;
    if (fd < 0) return;
#if __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
    t->error=ENOTSUP;return;
#endif
    struct stat s;
    if (fstat(fd,&s) || !S_ISREG(s.st_mode) || s.st_size!=0) { t->error=EINVAL;return; }
    t->events=malloc((size_t)ANCHOR_IO_MAX*sizeof *t->events);
    if (!t->events) { t->error=ENOMEM;return; }
    /* Fault the small fixed allocation before the workload starts. */
    memset(t->events,0,(size_t)ANCHOR_IO_MAX*sizeof *t->events);
    memcpy(t->header.magic,"ABIO0001",8);
}
static void anchor_io_record(anchor_io_trace *t, unsigned kind, uint64_t start, int64_t result) {
    const uint64_t end=prof_ns(CLOCK_MONOTONIC);
    const uint64_t offset=t->header.bytes[kind-1];
    if (result>0) t->header.bytes[kind-1]+=(uint64_t)result;
    if (t->header.count==ANCHOR_IO_MAX) { t->header.dropped++;return; }
    t->events[t->header.count++]=(anchor_io_event){start,end,offset,result,kind,0};
}
static int anchor_io_pwrite(int fd, const void *data, size_t bytes, off_t offset, uint64_t deadline) {
    const unsigned char *p=data;
    while (bytes) {
        if (prof_ns(CLOCK_MONOTONIC)>=deadline) return ETIMEDOUT;
        ssize_t n=pwrite(fd,p,bytes,offset);
        if (n<0) { if (errno==EINTR) continue;return errno; }
        if (n==0) return EIO;
        p+=n;offset+=n;bytes-=(size_t)n;
    }
    return 0;
}
static void anchor_io_finish(anchor_io_trace *t, int bridge_status) {
    if (!t->events) return;
    t->header.bridge_status=bridge_status;
    const uint64_t deadline=prof_ns(CLOCK_MONOTONIC)+5000000000ull;
    t->error=anchor_io_pwrite(t->fd,&t->header,sizeof t->header,0,deadline);
    if (!t->error) t->error=anchor_io_pwrite(t->fd,t->events,t->header.count*sizeof *t->events,sizeof t->header,deadline);
    if (!t->error) {
        t->header.complete=1;
        t->error=anchor_io_pwrite(t->fd,&t->header,sizeof t->header,0,deadline);
    }
    if (!t->error) t->file_bytes=sizeof t->header+t->header.count*sizeof *t->events;
    free(t->events);t->events=NULL;
}
#endif
