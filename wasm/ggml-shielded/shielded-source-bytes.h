#pragma once
#include <cstdint>
#include <limits>
#include <new>
#include <type_traits>
#include <vector>
#include <sys/mman.h>

// Registration scratch must disappear after encoding. Large malloc/free pairs
// can raise glibc's dynamic mmap threshold and move subsequent long-lived
// allocations into fragmented arenas. Keep only these temporary copies outside
// malloc; the encoded mask weights retain their existing allocator and layout.
template<class T> struct sh_source_allocator {
    using value_type = T;
    using is_always_equal = std::true_type;
    using propagate_on_container_move_assignment = std::true_type;
    sh_source_allocator() noexcept = default;
    template<class U> sh_source_allocator(const sh_source_allocator<U> &) noexcept {}
    T *allocate(size_t n) {
        if (n > std::numeric_limits<size_t>::max() / sizeof(T)) throw std::bad_array_new_length();
        if (!n) return nullptr;
        void *p = mmap(nullptr, n * sizeof(T), PROT_READ | PROT_WRITE,
                       MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        if (p == MAP_FAILED) throw std::bad_alloc();
        return static_cast<T *>(p);
    }
    void deallocate(T *p, size_t n) noexcept { if (p) munmap(p, n * sizeof(T)); }
};
template<class T, class U> bool operator==(const sh_source_allocator<T> &, const sh_source_allocator<U> &) noexcept { return true; }
template<class T, class U> bool operator!=(const sh_source_allocator<T> &, const sh_source_allocator<U> &) noexcept { return false; }
using sh_source_bytes = std::vector<uint8_t, sh_source_allocator<uint8_t>>;
