#define _GNU_SOURCE
#include "shielded-pads.c"
#include <assert.h>

int main(int argc,char **argv) {
    assert(argc==2);
    uint8_t pk[32],sk[32],other_pk[32],other_sk[32];
    crypto_box_keypair(pk,sk);crypto_box_keypair(other_pk,other_sk);
    uint8_t sid[16]={1},digest[32]={2},old[32],checked[32];
    assert(crypto_box_beforenm(old,pk,other_sk)==0);
    assert(box_shared_checked(checked,pk,other_sk)==SH_OK && !memcmp(old,checked,32));
    assert(box_shared_checked(checked,other_pk,sk)==SH_OK && !memcmp(old,checked,32));
    char good[1024],bad[1024];snprintf(good,sizeof good,"%s/good.pads",argv[1]);snprintf(bad,sizeof bad,"%s/bad.pads",argv[1]);
    sh_pads_group group={.group=0,.K=32,.u_len=3};strcpy(group.name,"box.weight");
    int err;sh_pads_writer *w=sh_pads_writer_open(good,digest,sid,&group,1,0,1,pk,&err);assert(w && !err);
    int32_t u[3]={-3,4,5};assert(sh_pads_writer_cell(w,0,0,u)==SH_OK);
    uint8_t key[32];memcpy(key,w->key,32);sh_pads_hdr header=w->hdr;
    assert(sh_pads_writer_close(w)==SH_OK);
    uint64_t lo=99,count=99;
    assert(sh_pads_shipment_check(good,sid,sk,digest,&lo,&count)==SH_OK && lo==0 && count==1);
    // A normal shipment's key wrap is still exactly compatible with TweetNaCl.
    uint8_t shared[32],nonce[24],opened[32];
    crypto_box_beforenm(shared,header.dealer_pk,sk);key_nonce(nonce,sid);
    assert(secretbox_open(opened,header.key_box,32,nonce,shared)==SH_OK && !memcmp(opened,key,32));
    for(int kind=0;kind<4;kind++) {
        uint8_t low[32]={0};low[0]=(uint8_t)(kind%2);if(kind>=2)low[31]=0x80;
        uint8_t raw[32];crypto_scalarmult(raw,sk,low);
        for(int i=0;i<32;i++)assert(raw[i]==0);
        memset(checked,0xa5,32);assert(box_shared_checked(checked,low,sk)==SH_ERR_VERIFY);
        for(int i=0;i<32;i++)assert(checked[i]==0);
        // Existing shipments are refused before key validation; a fresh path
        // reaches the zero-DH check without weakening non-overwrite protection.
        assert(!sh_pads_writer_open(good,digest,sid,&group,1,0,1,low,&err) && err==SH_ERR_IO);
        char rejected[1024];snprintf(rejected,sizeof rejected,"%s/rejected-%d.pads",argv[1],kind);
        assert(!sh_pads_writer_open(rejected,digest,sid,&group,1,0,1,low,&err) && err==SH_ERR_VERIFY);
        assert(access(rejected,F_OK)!=0);
        assert(sh_pads_shipment_check(good,sid,sk,digest,&lo,&count)==SH_OK);
        // Forge BOTH authenticators under the public zero-DH-derived key.
        // Tag failure would hide this bug, so confirm the old primitive opens it.
        sh_pads_hdr h=header;memcpy(h.dealer_pk,low,32);
        crypto_box_beforenm(shared,low,other_sk);
        assert(secretbox_seal(h.key_box,key,32,nonce,shared)==SH_OK);
        crypto_box_beforenm(old,low,sk);assert(!memcmp(shared,old,32));
        assert(secretbox_open(opened,h.key_box,32,nonce,old)==SH_OK && !memcmp(opened,key,32));
        uint8_t hash[64],hn[12];assert(header_hash(&h,&group,1,hash)==SH_OK);hdr_nonce(hn);
        assert(aead_seal(key,hn,hash,64,h.hdr_box)==SH_OK);
        int fd=open(bad,O_RDWR|O_CREAT|O_TRUNC,0600);assert(fd>=0);
        assert(pwrite(fd,&h,sizeof h,0)==sizeof h);assert(pwrite(fd,&group,sizeof group,sizeof h)==sizeof group);
        assert(ftruncate(fd,(off_t)(h.data_off+h.row_bytes))==0);
        lo=count=99;
        assert(sh_pads_shipment_check_fd(fd,sid,sk,digest,&lo,&count)==SH_ERR_VERIFY);
        assert(lo==99 && count==99 && fcntl(fd,F_GETFD)>=0);close(fd);
        assert(sh_pads_shipment_check(bad,sid,sk,digest,&lo,&count)==SH_ERR_VERIFY);
    }
    puts("pad-box-key: ok");
}
