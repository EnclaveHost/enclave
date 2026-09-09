/* Real framed exchanges: the narrow switch must trace only the wire unit. */
#include "../../wasm/ggml-shielded/shielded-wire.c"
#include <assert.h>
int other_profile_probe(void);
int main(int argc,char **argv) {
    assert(argc==3);int wire=atoi(argv[1]),other=atoi(argv[2]);
    int fds[2];assert(socketpair(AF_UNIX,SOCK_STREAM,0,fds)==0);
    sh_pipe *p=calloc(1,sizeof *p);assert(p);p->fd=fds[0];
    uint8_t req[24]={0};put_u32(req,1);put_u32(req+4,1);put_u32(req+8,17);
    for (unsigned i=1;i<=2;i++) {
        uint8_t reply[15]={0};put_u64(reply+1,6);memcpy(reply+9,"answer",6);
        assert(write(fds[1],reply,sizeof reply)==sizeof reply);
        sh_frame frame={SH_CMD_FIELD_GEMM24,req,7,req+7,sizeof req-7};sh_reply out;
        assert(sh_pipe_exchange(p,&frame,1,&out)==SH_OK);
        assert(out.len==6 && !memcmp(out.data,"answer",6));
        uint8_t got[33];assert(read_all(fds[1],got,sizeof got,NULL)==SH_OK);
        assert(got[0]==SH_CMD_FIELD_GEMM24 && get_u64(got+1)==24 && !memcmp(got+9,req,24));
    }
    sh_wire_timing timing;sh_pipe_wire_timing(p,&timing);
    assert(timing.calls==2 && timing.request_bytes==66 && timing.reply_bytes==30);
    assert(sh_sp_count==(wire?10u:0u));
    const char *tags[]={"write_request","overlap_work","read_header","reply_reserve","read_body"};
    const unsigned bytes[]={33,0,9,6,6};
    if (wire) for (unsigned i=0;i<10;i++) {
        sh_sp_row *r=&sh_sp_rows[i];assert(r->ready && r->tid && r->start.wall && r->start.cpu);
        assert(r->end.wall>=r->start.wall && r->end.cpu>=r->start.cpu);
        assert(!strcmp(r->tag,tags[i%5]) && r->a==i/5+1 && r->b==bytes[i%5]);
    }
    assert(other_profile_probe()==other);
    close(fds[1]);sh_pipe_close(p);puts("wire source profile: PASS");
}
