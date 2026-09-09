/* Scheduling attribution on the real framed path with deliberately delayed,
 * fragmented replies. No performance threshold is inferred from this fixture. */
#include "../../wasm/ggml-shielded/shielded-wire.c"
#include <assert.h>
#include <sys/mman.h>
static void delay_ms(long ms) {struct timespec t={0,ms*1000000};while(nanosleep(&t,&t)&&errno==EINTR){}}
static void *server(void *arg) {
    int fd=*(int *)arg;
    for(int i=0;i<2;i++) {
        uint8_t req[33];assert(read_all(fd,req,sizeof req,NULL)==SH_OK);
        assert(req[0]==SH_CMD_FIELD_GEMM24 && get_u64(req+1)==24);
        uint8_t reply[15]={0};put_u64(reply+1,6);memcpy(reply+9,"answer",6);
        delay_ms(12);assert(write(fd,reply,12)==12);delay_ms(4);assert(write(fd,reply+12,3)==3);
    }
    return NULL;
}
int main(int argc,char **argv) {
    assert(argc==2);const int enabled=atoi(argv[1]);uint64_t q=999;
    assert(sh_ws_parse("12 34 56\n",&q)==0 && q==34);
    assert(sh_ws_parse("12 -1 56\n",&q)==EINVAL);
    assert(sh_ws_parse("12 18446744073709551616 56\n",&q)==ERANGE);
    assert(sh_ws_parse("12 34\n",&q)==EINVAL);
    assert(sh_ws_parse("12 34 56 junk",&q)==EINVAL);
    errno=ECHILD;sh_ws_stamp a=sh_ws_now(1);assert(errno==ECHILD);
    assert(enabled ? a.before && !a.sched_error && !a.usage_error : !a.before);
    if(enabled) {
        size_t bytes=(size_t)sysconf(_SC_PAGESIZE)*64;
        volatile char *pages=mmap(NULL,bytes,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);assert(pages!=MAP_FAILED);
        sh_ws_stamp before=sh_ws_now(1);
        for(size_t i=0;i<bytes;i+=(size_t)sysconf(_SC_PAGESIZE))pages[i]=1;
        sh_ws_stamp after=sh_ws_now(1);long minor,major;
        assert(!sh_ws_fault_delta(&before,&after,&minor,&major) && minor>=64 && major>=0);
        assert(!munmap((void *)pages,bytes));
        before.minor_faults=after.minor_faults+1;
        assert(sh_ws_fault_delta(&before,&after,&minor,&major)==ERANGE && !minor && !major);
        before.usage_error=EACCES;
        assert(sh_ws_fault_delta(&before,&after,&minor,&major)==EACCES && !minor && !major);
    }
    int fds[2];assert(socketpair(AF_UNIX,SOCK_STREAM,0,fds)==0);
    pthread_t thread;assert(!pthread_create(&thread,NULL,server,&fds[1]));
    sh_pipe *p=calloc(1,sizeof *p);assert(p);p->fd=fds[0];uint8_t req[24]={0};
    for(int i=0;i<2;i++) {
        sh_frame f={SH_CMD_FIELD_GEMM24,req,sizeof req,NULL,0};sh_reply out;
        assert(sh_pipe_exchange(p,&f,1,&out)==SH_OK);
        assert(out.len==6 && !memcmp(out.data,"answer",6));
    }
    assert(!pthread_join(thread,NULL));
    assert(sh_ws_count==(enabled?6u:0u));
    if(enabled) {
        const char *tags[]={"write_request","read_header","read_body"};
        unsigned cap=sh_ws_count<SH_WS_CAP?sh_ws_count:SH_WS_CAP;
        for(unsigned i=0;i<cap;i++) {
            sh_ws_row *r=&sh_ws_rows[i];assert(r->ready && r->tid && r->call==i/3+1 && !strcmp(r->tag,tags[i%3]));
            assert(r->start.before<=r->start.after && r->start.after<=r->end.before && r->end.before<=r->end.after);
            assert(!r->start.sched_error && !r->end.sched_error && !r->start.usage_error && !r->end.usage_error);
            assert(r->end.runq>=r->start.runq && r->end.runq-r->start.runq<=r->end.after-r->start.before);
            if(i%3==1) {assert(r->end.before-r->start.after>=8000000);assert(r->end.voluntary>r->start.voluntary);}
        }
    }
    sh_wire_timing t;sh_pipe_wire_timing(p,&t);assert(t.calls==2);
    unsigned dumped=sh_ws_dumped;sh_pipe_wire_timing(p,&t);assert(sh_ws_dumped==dumped);
    close(fds[1]);sh_pipe_close(p);puts("wire scheduling profile: PASS");
}
