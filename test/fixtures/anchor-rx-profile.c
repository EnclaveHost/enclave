#define ANCHOR_RX_PROFILE_INTERVAL_MS 20
#include "../../shielded/anchor/avf/payload/anchor_rx_profile.h"
#include <assert.h>
#include <unistd.h>
static unsigned count, writes, reads;static uint64_t max_age;
static void sink(void *ctx,const char *line) {
 (void)ctx;unsigned long long mono,age,got,total;char stage[40];
 assert(sscanf(line,"PAD_RX progress mono_us=%llu stage=%39s stage_age_us=%llu written=%llu expected=%llu",&mono,stage,&age,&got,&total)==5);
 assert(total==809039872 && got<=total);++count;
 if(!strcmp(stage,"write_file")){assert(got==67108864);++writes;if(age>max_age)max_age=age;}
 if(!strcmp(stage,"read_stream")){assert(got==134217728);++reads;}
}
int main(void){anchor_rx_profile p;assert(!anchor_rx_profile_start(&p,809039872,sink,NULL));
 anchor_rx_profile_mark(&p,ARX_WRITE,67108864);usleep(100000);
 anchor_rx_profile_mark(&p,ARX_READ,134217728);usleep(60000);
 uint64_t t=anchor_rx_profile_now();anchor_rx_profile_stop(&p);assert(anchor_rx_profile_now()-t<100000);
 assert(writes>=3 && reads>=2 && max_age>=60000);unsigned last=count;usleep(40000);assert(count==last);
 anchor_rx_profile_mark(&p,ARX_DONE,809039872);anchor_rx_profile_stop(&p);assert(count==last);
 printf("PASS progress=%u write=%u read=%u stalled_stage_age_us=%llu joined_promptly=1\n",count,writes,reads,(unsigned long long)max_age);
}
