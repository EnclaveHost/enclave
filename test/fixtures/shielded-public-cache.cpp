#include "public-weight-cache.h"
#include <cassert>
#include <thread>
#include <cstdio>

static std::array<uint8_t,32> digest(const std::vector<uint8_t>&v) {
    std::array<uint8_t,32> out; sha256_ctx c; sha_init(&c);
    sha_update(&c, v.data(), v.size()); sha_final(&c, out.data()); return out;
}
int main() {
    std::vector<uint8_t> a(8,1), b(8,2), c(8,3), out(16,77);
    auto da=digest(a), db=digest(b), dc=digest(c);
    PublicWeightCache off;
    assert(off.admit(da.data(),a.data(),8)==0 && !off.copy(da.data(),8,out.data()));
    PublicWeightCache cache(16);
    assert(cache.admit(da.data(),a.data(),8)==1);
    a[0]=99; assert(cache.copy(da.data(),8,out.data()) && out[0]==1); a[0]=1;
    out[0]=99; assert(cache.copy(da.data(),8,out.data()) && out[0]==1);
    assert(cache.admit(db.data(),b.data(),8)==1 && cache.used()==16);
    assert(cache.admit(da.data(),a.data(),8)==1 && cache.count()==2);
    assert(cache.admit(da.data(),b.data(),8)==-1 && cache.count()==2);
    assert(cache.admit(dc.data(),c.data(),8)==1 && cache.used()==16);
    assert(!cache.copy(db.data(),8,out.data())); // duplicate A refreshed its LRU position
    assert(cache.copy(da.data(),8,out.data()));
    assert(!cache.copy(da.data(),7,out.data())); // length is part of identity
    std::vector<uint8_t> huge(17,0); auto dh=digest(huge);
    assert(cache.admit(dh.data(),huge.data(),17)==0 && cache.count()==2);
    auto wrong=dc; wrong[0]^=1;
    assert(cache.admit(wrong.data(),c.data(),8)==-1);
    assert(!cache.copy(wrong.data(),8,out.data()) && cache.used()<=16);
    uint8_t request[58]={}; request[1]=1; request[17]=8;
    PublicWeightRequest r;
    assert(public_weight_request(request,57,r) && r.bid==1 && r.nbytes==8);
    for(size_t n=0;n<57;n++) assert(!public_weight_request(request,n,r));
    assert(!public_weight_request(request,58,r));
    request[0]=2; assert(!public_weight_request(request,57,r)); request[0]=0;
    request[17]=0; assert(!public_weight_request(request,57,r));
    PublicWeightCache concurrent(4096*8+32);
    std::vector<std::thread> threads;
    for(int t=0;t<4;t++) threads.emplace_back([&,t] {
        for(unsigned i=0;i<1300;i++) {
            uint64_t id=(uint64_t)t*1300+i;
            std::vector<uint8_t> data(8), got(8); memcpy(data.data(),&id,8);
            auto d=digest(data); assert(concurrent.admit(d.data(),data.data(),8)==1);
            if(concurrent.copy(d.data(),8,got.data())) assert(got==data);
            assert(concurrent.used()<=concurrent.budget() && concurrent.count()<=4096);
        }
    });
    for(auto &t:threads)t.join();
    assert(concurrent.count()==4096 && concurrent.used()==4096*8);
    puts("public-cache: immutable identity, LRU bounds, malformed requests and concurrency PASS");
}
