/* ee-backend-reg.cpp -- ggml's backend registry WITHOUT dynamic loading, for the enclave: the CPU
 * backend and the shielded backend are linked in and registered explicitly (ee-main.cpp). Replaces
 * ggml/src/ggml-backend-reg.cpp, whose std::filesystem and LoadLibrary paths do not exist in VTL1. */
#include "ggml-backend-impl.h"
#include "ggml-backend.h"
#include "ggml-cpu.h"
#include <vector>
#include <cstring>
struct ee_registry {
    std::vector<ggml_backend_reg_t> backends; std::vector<ggml_backend_dev_t> devices;
    ee_registry() { register_backend(ggml_backend_cpu_reg()); }
    void register_backend(ggml_backend_reg_t r) { if (!r) return; for (auto b : backends) if (b == r) return; backends.push_back(r); for (size_t i = 0; i < ggml_backend_reg_dev_count(r); i++) register_device(ggml_backend_reg_dev_get(r, i)); }
    void register_device(ggml_backend_dev_t d) { for (auto x : devices) if (x == d) return; devices.push_back(d); }
};
static ee_registry &R() { static ee_registry r; return r; }
void ggml_backend_register(ggml_backend_reg_t r) { R().register_backend(r); }
void ggml_backend_device_register(ggml_backend_dev_t d) { R().register_device(d); }
size_t ggml_backend_reg_count() { return R().backends.size(); }
ggml_backend_reg_t ggml_backend_reg_get(size_t i) { return i < R().backends.size() ? R().backends[i] : nullptr; }
ggml_backend_reg_t ggml_backend_reg_by_name(const char *n) { for (auto r : R().backends) if (!_stricmp(ggml_backend_reg_name(r), n)) return r; return nullptr; }
size_t ggml_backend_dev_count() { return R().devices.size(); }
ggml_backend_dev_t ggml_backend_dev_get(size_t i) { return i < R().devices.size() ? R().devices[i] : nullptr; }
ggml_backend_dev_t ggml_backend_dev_by_name(const char *n) { for (auto d : R().devices) if (!_stricmp(ggml_backend_dev_name(d), n)) return d; return nullptr; }
ggml_backend_dev_t ggml_backend_dev_by_type(enum ggml_backend_dev_type t) { for (auto d : R().devices) if (ggml_backend_dev_type(d) == t) return d; return nullptr; }
ggml_backend_t ggml_backend_init_by_name(const char *n, const char *p) { auto d = ggml_backend_dev_by_name(n); return d ? ggml_backend_dev_init(d, p) : nullptr; }
ggml_backend_t ggml_backend_init_by_type(enum ggml_backend_dev_type t, const char *p) { auto d = ggml_backend_dev_by_type(t); return d ? ggml_backend_dev_init(d, p) : nullptr; }
ggml_backend_t ggml_backend_init_best(void) { auto d = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_GPU); if (!d) d = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU); return d ? ggml_backend_dev_init(d, nullptr) : nullptr; }
ggml_backend_reg_t ggml_backend_load(const char *) { return nullptr; }
void ggml_backend_unload(ggml_backend_reg_t) {}
void ggml_backend_load_all() {}
void ggml_backend_load_all_from_path(const char *) {}
