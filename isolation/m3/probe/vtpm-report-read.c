/* Disposable diagnostic init only. Reads the guest's public OpenHCL attestation
 * NV index and binds a nonce in its disposable guest input index. Never opens
 * the host TPM or exports private keys.
 * Keep this image out of all production image allowlists. */
#define _GNU_SOURCE
#include <errno.h>
#include <cpuid.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/mman.h>
#include <sys/io.h>
#include <sys/syscall.h>
#include <sys/random.h>
#include <time.h>
#include <sys/wait.h>
#include <unistd.h>

static uint16_t u16(const unsigned char *p) { return (uint16_t)p[0] << 8 | p[1]; }
static uint32_t u32(const unsigned char *p) { return (uint32_t)u16(p) << 16 | u16(p+2); }
static void put16(unsigned char *p, uint16_t x) { p[0]=x>>8; p[1]=x; }
static volatile uint32_t *crb;
static unsigned char *io_pages;

/* Diagnostic-only transport for OpenHCL's x86 vTPM, whose direct Linux loader
 * does not describe the device in ACPI. Match the pinned OpenHCL public register
 * protocol; allocate only this probe's command/response pages inside THIS guest.
 * No page is marked host-shared and no memory of another process is inspected. */
static int direct_transport(void) {
    unsigned a,b,c,d;
    __cpuid(0x40000000,a,b,c,d);
    if(a<0x4000000c || b!=0x7263694d || c!=0x666f736f || d!=0x76482074) return -1;
    __cpuid(0x4000000c,a,b,c,d);
    if((b&15)!=1) return -1;
    int mem=open("/dev/mem",O_RDWR|O_SYNC|O_CLOEXEC);
    if(mem<0) { printf("TPMPROBE direct mem: %s\n",strerror(errno)); return -1; }
    crb=mmap(NULL,4096,PROT_READ|PROT_WRITE,MAP_SHARED,mem,0xfed40000);
    close(mem);
    if(crb==MAP_FAILED) { crb=NULL; return -1; }
    printf("TPMPROBE CRB interface=0x%08x\n",crb[0x30/4]);
    if(crb[0x30/4]!=0x4011) return -1;
    int mod=open("/enclave-tpm-probe.ko",O_RDONLY|O_CLOEXEC);
    /* Diagnostic image only: module built against the exact kernel source, but
     * the old kernel build did not preserve Module.symvers. Never ship this. */
    if(mod<0 || syscall(SYS_finit_module,mod,"",3)) {
        printf("TPMPROBE diagnostic module: %s\n",strerror(errno));
        if(mod>=0)close(mod);
        return -1;
    }
    close(mod);
    int dev=open("/dev/enclave-tpm-probe",O_RDWR|O_CLOEXEC);
    if(dev<0) {printf("TPMPROBE guest transport device: %s\n",strerror(errno));return -1;}
    io_pages=mmap(NULL,8192,PROT_READ|PROT_WRITE,MAP_SHARED,dev,0);
    close(dev);
    if(io_pages==MAP_FAILED){printf("TPMPROBE buffer mapping: %s\n",strerror(errno));return -1;}
    if(crb[0x58/4]!=4096){printf("TPMPROBE buffer initialization failed\n");return -1;}
    printf("TPMPROBE direct guest-vTPM transport initialized\n");
    return 0;
}
static int command(int fd, const unsigned char *in, size_t len, unsigned char *out, size_t cap) {
    ssize_t n;
    if(fd>=0) {
        if (write(fd,in,len)!=(ssize_t)len) { printf("TPMPROBE write error=%s\n",strerror(errno)); return -1; }
        n=read(fd,out,cap);
    } else {
        if(len>4096) return -1;
        memset(io_pages,0,8192);memcpy(io_pages,in,len);
        __sync_synchronize();crb[0x4c/4]=1;
        unsigned polls=0;
        while(crb[0x4c/4]&1) { if(++polls>10000)return -1; usleep(1000); }
        __sync_synchronize();
        n=u32(io_pages+4096+2);
        if(n<10 || n>4096 || (size_t)n>cap)return -1;
        memcpy(out,io_pages+4096,n);
    }
    if(n<10 || u32(out+2)!=(uint32_t)n) { printf("TPMPROBE invalid response size=%zd\n",n); return -1; }
    if(u32(out+6)) { printf("TPMPROBE rc=0x%08x\n",u32(out+6)); return -1; }
    return (int)n;
}
static int probe(void) {
    unsigned char response[8192],report[8192];
    int fd=open("/dev/tpm0",O_RDWR|O_CLOEXEC);
    if(fd<0) {
        printf("TPMPROBE open /dev/tpm0: %s\n",strerror(errno));
        if(direct_transport())return 1;
        const unsigned char startup[]={0x80,1,0,0,0,12,0,0,1,0x44,0,0};
        /* This is a fresh, disposable guest TPM; INITIALIZE means already started. */
        (void)command(-1,startup,sizeof startup,response,sizeof response);
    }
    /* Only this disposable guest's nonce-input index is writable. OpenHCL
     * binds it into the public report; never use or write the host TPM. */
    unsigned char inputpub[]={0x80,1,0,0,0,14,0,0,1,0x69,1,0x40,0,2};
    if(command(fd,inputpub,sizeof inputpub,response,sizeof response)<0) {
        unsigned char define[]={0x80,2,0,0,0,45,0,0,1,0x2a,
          0x40,0,0,1,0,0,0,9,0x40,0,0,9,0,0,0,0,0,
          0,0,0,14,1,0x40,0,2,0,0x0b,0,6,0,6,0,0,0,64};
        if(command(fd,define,sizeof define,response,sizeof response)<0)return 1;
    }
    unsigned char nonce[64];
    if(getrandom(nonce,sizeof nonce,0)!=sizeof nonce)return 1;
    unsigned char wr[99]={0x80,2,0,0,0,99,0,0,1,0x37,
      0x40,0,0,1,1,0x40,0,2,0,0,0,9,0x40,0,0,9,0,0,0,0,0,0,64};
    memcpy(wr+33,nonce,64);
    if(command(fd,wr,sizeof wr,response,sizeof response)<0)return 1;
    printf("TPMPROBE challenge ");for(unsigned i=0;i<64;i++)printf("%02x",nonce[i]);putchar('\n');
    /* OpenHCL deliberately throttles report refresh to once per two seconds. */
    sleep(3);
    /* TPM2_NV_ReadPublic(0x01400001), OpenHCL's public attestation report. */
    unsigned char pub[]={0x80,1,0,0,0,14,0,0,1,0x69,1,0x40,0,1};
    int n=command(fd,pub,sizeof pub,response,sizeof response);
    if(n<26 || u16(response)!=0x8001 || u32(response+12)!=0x01400001) return close(fd),1;
    size_t policy=u16(response+22),pubsize=u16(response+10);
    if(pubsize!=14+policy || 26+policy>(size_t)n) return close(fd),1;
    unsigned size=u16(response+24+policy);
    printf("TPMPROBE index=0x01400001 bytes=%u attributes=0x%08x\n",size,u32(response+18));
    if(!size || size>sizeof report) return close(fd),1;
    for(unsigned off=0;off<size;) {
        unsigned take=size-off; if(take>512)take=512;
        /* Owner-authorized NV_Read, empty password; read-only guest device. */
        unsigned char readcmd[]={0x80,2,0,0,0,35,0,0,1,0x4e,
          0x40,0,0,1,1,0x40,0,1,0,0,0,9,0x40,0,0,9,0,0,0,0,0,0,0,0,0};
        put16(readcmd+31,take);put16(readcmd+33,off);
        n=command(fd,readcmd,sizeof readcmd,response,sizeof response);
        if(n<16 || u16(response)!=0x8002 || u32(response+10)!=take+2 ||
           u16(response+14)!=take || (unsigned)n<16+take) return close(fd),1;
        memcpy(report+off,response+16,take);off+=take;
    }
    close(fd);
    for(unsigned off=0;off<size;off+=64) {
        printf("TPMPROBE report %04x ",off);
        for(unsigned i=off;i<size && i<off+64;i++) printf("%02x",report[i]);
        putchar('\n');
    }
    printf("TPMPROBE read complete; unverified public evidence only\n");
    return 0;
}
int main(void) {
    mount("devtmpfs","/dev","devtmpfs",0,NULL);
    mount("proc","/proc","proc",0,NULL);
    int console=open("/dev/console",O_RDWR);
    if(console>=0) { dup2(console,0); dup2(console,1); dup2(console,2); if(console>2)close(console); }
    setvbuf(stdout,NULL,_IONBF,0);
    printf("TPMPROBE diagnostic image: never production\n");
    pid_t child=fork();
    int result=1,status=0;
    if(child==0) { alarm(20); _exit(probe()); }
    if(child>0) {
        pid_t waited;
        do { waited=waitpid(child,&status,0); } while(waited<0 && errno==EINTR);
        if(waited==child && WIFEXITED(status)) result=WEXITSTATUS(status);
        else printf("TPMPROBE timed out or terminated\n");
    }
    printf("TPMPROBE result=%d\n",result);
    /* Continue the existing measured init so its usual cleanup/control works. */
    execl("/init-real","/init-real",(char*)NULL);
    printf("TPMPROBE init failed: %s\n",strerror(errno));
    for(;;) pause();
}
