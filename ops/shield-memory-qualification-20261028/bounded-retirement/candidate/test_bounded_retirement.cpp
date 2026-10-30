// Source-only candidate tests: opt-in bounded deferred retirement of private
// originals. Real tmpfs files (memfd), real hole punching, real SHA-256 table.
// The read/verify pairs model the backend's copy -> authenticate -> encode.
#include "shield-original-source.hpp"
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <initializer_list>
#include <string>
#include <vector>
#include <sys/mman.h>
#include <sys/stat.h>

namespace {
int failures = 0;
#define CHECKL(c, line) do { if (!(c)) { fprintf(stderr, "%s:%d: CHECK(%s) failed\n", __FILE__, (int)(line), #c); failures++; } } while (0)
#define CHECK(c) CHECKL(c, __LINE__)
#define REQUIRE(c) do { if (!(c)) { CHECK(c); return; } } while (0)

constexpr uint32_t kType = 8;
enum { READ_OK = 0, READ_FAILED = 1, AUTH_FAILED = 2 };

struct tensor { const char *name; uint64_t off, size; bool gpu; };

struct fixture {
    shield_original_source s;
    std::vector<unsigned char> img;
    std::vector<tensor> ts;
    uint64_t pg = 0, initial_blocks = 0;
    void *map = MAP_FAILED;
    ~fixture() { if (map != MAP_FAILED) munmap(map, img.size()); }
    const tensor &t(const char *name) const {
        for (auto &x : ts) if (!strcmp(x.name, name)) return x;
        abort();
    }
};

std::array<int64_t, 4> ne_of(const tensor &t) { return {int64_t(t.size), 1, 1, 1}; }
uint64_t interior(uint64_t pg, uint64_t off, uint64_t n) {
    const uint64_t b = (off + pg - 1) / pg * pg, e = (off + n) / pg * pg;
    return e > b ? e - b : 0;
}
uint64_t allocated(int fd) { struct stat st{}; return fstat(fd, &st) ? UINT64_MAX : uint64_t(st.st_blocks) * 512; }
bool write_all(int fd, const std::vector<unsigned char> &img) {
    for (size_t at = 0; at < img.size();) {
        const ssize_t put = pwrite(fd, img.data() + at, img.size() - at, (off_t)at);
        if (put < 0 && errno == EINTR) continue;
        if (put <= 0) return false;
        at += (size_t)put;
    }
    return true;
}
int memfd_with(const char *name, const std::vector<unsigned char> &img) {
    const int fd = memfd_create(name, MFD_CLOEXEC);
    if (fd >= 0 && !write_all(fd, img)) { close(fd); return -1; }
    return fd;
}

// GPU sources A-D share boundary pages with CPU tensors and each other, so a
// punch that strays past a tensor's interior changes a CPU or unread byte.
bool make(fixture &f, uint64_t budget, bool defer, bool readonly_private = false) {
    const uint64_t pg = (uint64_t)sysconf(_SC_PAGESIZE);
    f.pg = pg;
    f.ts = {
        {"cpu0", 0, 2*pg + 100, false},
        {"A", 2*pg + 100, 5*pg + 300, true},
        {"cpu1", 7*pg + 400, 200, false},
        {"B", 7*pg + 600, 6*pg, true},
        {"C", 13*pg + 600, 4*pg + 1000, true},
        {"D", 17*pg + 1600, 3*pg + 50, true},
        {"cpu2", 20*pg + 1650, pg, false},
    };
    f.img.resize(22*pg);
    uint64_t x = 0x9e3779b97f4a7c15ull;
    for (auto &b : f.img) { x ^= x << 13; x ^= x >> 7; x ^= x << 17; b = (unsigned char)x; }
    int priv = memfd_with("shield-private", f.img);
    const int back = memfd_with("shield-backing", f.img);
    if (priv < 0 || back < 0) return false;
    if (readonly_private) {
        char path[64]; snprintf(path, sizeof path, "/proc/self/fd/%d", priv);
        const int ro = open(path, O_RDONLY | O_CLOEXEC);
        close(priv); priv = ro;
        if (priv < 0) { close(back); return false; }
    }
    f.s.private_fd = priv; f.s.backing_fd = back;
    f.s.file_size = f.img.size(); f.s.page = pg;
    f.s.defer_retirement = defer; f.s.retire_budget = budget;
    for (auto &t : f.ts) { auto ne = ne_of(t); f.s.add(t.name, kType, ne.data(), t.off, t.size); }
    f.initial_blocks = allocated(priv);
    f.map = mmap(nullptr, f.img.size(), PROT_READ, MAP_SHARED, priv, 0);
    if (f.initial_blocks != f.img.size())
        fprintf(stderr, "private memfd allocates %llu bytes for %zu written; tmpfs huge pages?\n",
                (unsigned long long)f.initial_blocks, f.img.size());
    return f.map != MAP_FAILED && f.initial_blocks == f.img.size();
}

// One card's registration read: copy into a private buffer, then authenticate.
int card_read(fixture &f, const char *name, bool *matches = nullptr) {
    const auto &t = f.t(name);
    auto ne = ne_of(t);
    std::vector<unsigned char> out(t.size, 0);
    if (shield_original_source::read(&f.s, name, kType, ne.data(), out.data(), t.size)) return READ_FAILED;
    if (matches) *matches = !memcmp(out.data(), f.img.data() + t.off, t.size);
    return shield_original_source::verify(&f.s, name, kType, ne.data(), out.data(), t.size) ? AUTH_FAILED : READ_OK;
}

// Exactly the named sources are retired; released bytes and tmpfs blocks
// equal their page interiors; every other byte of the private file is intact.
void check_state(fixture &f, const std::vector<const char *> &retired, int line) {
    uint64_t expect = 0;
    for (auto &t : f.ts) {
        bool r = false;
        for (auto *n : retired) r = r || !strcmp(n, t.name);
        CHECKL(f.s.entries.at(t.name).retired == r, line);
        std::vector<unsigned char> b(t.size);
        CHECKL(shield_original_source::read_at(f.s.private_fd, b.data(), t.size, t.off), line);
        if (!r) {
            CHECKL(!memcmp(b.data(), f.img.data() + t.off, t.size), line);
            if (!t.gpu) CHECKL(!memcmp((unsigned char *)f.map + t.off, f.img.data() + t.off, t.size), line);
            continue;
        }
        expect += interior(f.pg, t.off, t.size);
        const uint64_t lo = (t.off + f.pg - 1) / f.pg * f.pg, hi = (t.off + t.size) / f.pg * f.pg;
        for (uint64_t i = t.off; i < t.off + t.size; i++) {
            const unsigned char want = i >= lo && i < hi ? 0 : f.img[i];
            if (b[i - t.off] != want) { CHECKL(b[i - t.off] == want, line); break; }
        }
    }
    CHECKL(f.s.released_bytes == expect, line);
    CHECKL(allocated(f.s.private_fd) == f.initial_blocks - expect, line);
    uint64_t pending = 0;
    for (auto &kv : f.s.entries) if (kv.second.consumed && !kv.second.retired) pending += kv.second.size;
    if (f.s.retire_budget) CHECKL(f.s.unretired_bytes == pending, line);
    else CHECKL(f.s.unretired_bytes == 0 && f.s.unretired.empty(), line);
}

void test_default_retains_until_flush() {
    fixture f; REQUIRE(make(f, 0, true));
    for (auto *n : {"A", "B", "C"}) {
        bool same = false;
        CHECK(card_read(f, n, &same) == READ_OK && same);   // card 0
        CHECK(card_read(f, n, &same) == READ_OK && same);   // card 1, same tensor
        check_state(f, {}, __LINE__);
    }
    CHECK(f.s.reread_bytes == 0);
    CHECK(shield_original_source::release_consumed(&f.s) == 0);
    check_state(f, {"A", "B", "C"}, __LINE__);
    CHECK(card_read(f, "D") == READ_OK);                     // unread source stayed private
    CHECK(f.s.reread_bytes == 0);
    CHECK(card_read(f, "A") == READ_OK);                     // later fallback: authenticated reread
    CHECK(f.s.reread_bytes == f.t("A").size);
}

void test_bounded_budget_accounting() {
    fixture f; REQUIRE(make(f, 0, true));
    f.s.retire_budget = f.t("A").size + f.t("B").size;
    struct step { const char *read; std::vector<const char *> retired; };
    const step steps[] = {
        {"A", {}}, {"A", {}}, {"B", {}}, {"B", {}},
        {"C", {"A"}}, {"C", {"A"}}, {"D", {"A", "B"}}, {"D", {"A", "B"}},
    };
    for (auto &st : steps) {
        bool same = false;
        CHECK(card_read(f, st.read, &same) == READ_OK && same);
        check_state(f, st.retired, __LINE__);
        CHECK(f.s.unretired_bytes <= std::max<uint64_t>(f.s.retire_budget, f.t(st.read).size));
        CHECK(f.s.reread_bytes == 0);                         // no host reread inside the batch
    }
    CHECK(shield_original_source::release_consumed(&f.s) == 0);
    check_state(f, {"A", "B", "C", "D"}, __LINE__);
    CHECK(f.s.unretired.empty() && f.s.unretired_bytes == 0);
}

void test_tiny_budget_rereads_authenticate() {
    fixture f; REQUIRE(make(f, 0, true));
    f.s.retire_budget = 1;                                     // smaller than any tensor
    CHECK(card_read(f, "A") == READ_OK); check_state(f, {}, __LINE__);
    CHECK(card_read(f, "A") == READ_OK); check_state(f, {}, __LINE__);   // kept for card 1
    CHECK(card_read(f, "B") == READ_OK); check_state(f, {"A"}, __LINE__);
    CHECK(card_read(f, "B") == READ_OK); check_state(f, {"A"}, __LINE__);
    CHECK(f.s.reread_bytes == 0 && f.s.unretired_bytes == f.t("B").size);

    // A non-adjacent cross-card read of a retired source goes to backing and
    // is authenticated every time.
    bool same = false;
    CHECK(card_read(f, "A", &same) == READ_OK && same);
    CHECK(card_read(f, "A", &same) == READ_OK && same);
    CHECK(f.s.reread_bytes == 2 * f.t("A").size);
    check_state(f, {"A"}, __LINE__);                           // a reread never re-enters the budget

    // Corrupt backing: the read copies it, authentication refuses it.
    const uint64_t at = f.t("A").off + 17;
    const unsigned char bad = (unsigned char)(f.img[at] ^ 0x5a);
    CHECK(pwrite(f.s.backing_fd, &bad, 1, (off_t)at) == 1);
    CHECK(card_read(f, "A") == AUTH_FAILED);
    CHECK(pwrite(f.s.backing_fd, &f.img[at], 1, (off_t)at) == 1);
    CHECK(card_read(f, "A") == READ_OK);

    // Corrupt backing under the still-private B: B is not read from backing.
    const uint64_t bt = f.t("B").off + 33;
    const unsigned char bad_b = (unsigned char)(f.img[bt] ^ 0xa5);
    CHECK(pwrite(f.s.backing_fd, &bad_b, 1, (off_t)bt) == 1);
    CHECK(card_read(f, "B") == READ_OK);

    // Truncated backing: a retired source cannot be read; fail closed.
    CHECK(ftruncate(f.s.backing_fd, (off_t)(f.t("A").off + f.t("A").size - 1)) == 0);
    CHECK(card_read(f, "A") == READ_FAILED);
    CHECK(card_read(f, "C") == READ_OK);                       // retires B (C is current)
    check_state(f, {"A", "B"}, __LINE__);
    CHECK(card_read(f, "B") == READ_FAILED);                   // truncated beyond B too
}

void test_retire_failure_fails_closed() {
    fixture f; REQUIRE(make(f, 0, true, true));                 // private fd cannot punch
    f.s.retire_budget = 1;
    CHECK(card_read(f, "A") == READ_OK);
    CHECK(card_read(f, "B") == READ_FAILED);                   // retiring A failed
    CHECK(!f.s.entries.at("A").retired && f.s.released_bytes == 0);
    CHECK(allocated(f.s.private_fd) == f.initial_blocks);
    CHECK(shield_original_source::release_consumed(&f.s) == -1);
}

void test_accounting_overflow_refused() {
    fixture f; REQUIRE(make(f, 0, true));
    f.s.retire_budget = 64u << 20;
    f.s.unretired_bytes = UINT64_MAX - 10;
    CHECK(card_read(f, "A") == READ_FAILED);
    CHECK(!f.s.entries.at("A").consumed && f.s.unretired.empty());
}

void test_lookup_mismatch_refused() {
    fixture f; REQUIRE(make(f, 64u << 20, true));
    const auto &t = f.t("A"); auto ne = ne_of(t);
    std::vector<unsigned char> out(t.size);
    CHECK(shield_original_source::read(&f.s, "A", kType + 1, ne.data(), out.data(), t.size) == -1);
    CHECK(shield_original_source::read(&f.s, "A", kType, ne.data(), out.data(), t.size - 1) == -1);
    CHECK(!f.s.entries.at("A").consumed && f.s.unretired_bytes == 0);
}

void test_immediate_mode_unchanged() {
    fixture f; REQUIRE(make(f, 0, false));
    CHECK(card_read(f, "A") == READ_OK);
    check_state(f, {"A"}, __LINE__);
    CHECK(card_read(f, "A") == READ_OK && f.s.reread_bytes == f.t("A").size);
}


// Model source prefetch while the prior tensor's private copy is still awaiting
// verification. Retirement and later hostile disk mutation cannot change it.
void test_prefetched_retirement_keeps_staged_copy() {
    fixture f; REQUIRE(make(f, 1, true));
    const auto &a = f.t("A"); auto ne = ne_of(a);
    std::vector<unsigned char> staged(a.size);
    CHECK(shield_original_source::read(&f.s,"A",kType,ne.data(),staged.data(),a.size)==0);
    CHECK(card_read(f,"B")==READ_OK);
    CHECK(f.s.entries.at("A").retired);
    unsigned char bad = f.img[a.off] ^ 0xff;
    CHECK(pwrite(f.s.backing_fd,&bad,1,a.off)==1);
    CHECK(shield_original_source::verify(&f.s,"A",kType,ne.data(),staged.data(),a.size)==0);
    CHECK(card_read(f,"A")==AUTH_FAILED);
    check_state(f,{"A"},__LINE__);
    CHECK(shield_original_source::release_consumed(&f.s)==0);
    CHECK(shield_original_source::release_consumed(&f.s)==0);
    check_state(f,{"A","B"},__LINE__);
}

void test_budget_parsing() {
    uint64_t b = 1;
    CHECK(shield_original_source::parse_retire_budget_mib(nullptr, b) && b == 0);
    b = 1;
    CHECK(shield_original_source::parse_retire_budget_mib("", b) && b == 0);
    const struct { const char *v; uint64_t bytes; } ok[] = {
        {"64", 64ull << 20}, {"256", 256ull << 20}, {"1024", 1ull << 30}, {"65536", 65536ull << 20},
    };
    for (auto &c : ok) CHECK(shield_original_source::parse_retire_budget_mib(c.v, b) && b == c.bytes);
    for (auto *v : {"0", "00", "0256", "63", "65537", "99999", "100000", "-1", "+256", " 256",
                    "256 ", "256MiB", "0x100", "1e3", "256\n", "18446744073709551616"}) {
        b = 1;
        CHECK(!shield_original_source::parse_retire_budget_mib(v, b) && b == 0);
    }
}
}

int main() {
    test_default_retains_until_flush();
    test_bounded_budget_accounting();
    test_tiny_budget_rereads_authenticate();
    test_retire_failure_fails_closed();
    test_accounting_overflow_refused();
    test_lookup_mismatch_refused();
    test_immediate_mode_unchanged();
    test_budget_parsing();
    test_prefetched_retirement_keeps_staged_copy();
    if (failures) { fprintf(stderr, "%d check(s) failed\n", failures); return 1; }
    puts("bounded retirement: all checks passed");
    return 0;
}
