/* ee-stl-support.cpp -- what the STL runtime sources in stl/ want from Win32 NLS and from the UCRT's
 * locale machinery, answered for the "C" locale only. An enclave has no locale data and needs none:
 * the engine's text handling is its own (unicode.cpp); the standard library only formats numbers
 * and runs the odd regex over ASCII patterns. Everything here is deterministic and allocation-free. */
#include <windows.h>
#include <locale.h>
#include <ctype.h>
#include <string.h>
#include <wchar.h>
#include <stdlib.h>
#include <isa_availability.h>
#include "stl/awint.hpp"
#include "ee-rt.h"

extern "C" {
/* ---- UCRT locale internals ---------------------------------------------------------------- */
static wchar_t *g_locnames[8] = { nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr };   /* every category null = "C" */
wchar_t **__cdecl ___lc_locale_name_func(void) { return g_locnames; }
unsigned int __cdecl ___lc_codepage_func(void) { return 0; }
unsigned int __cdecl ___lc_collate_cp_func(void) { return 0; }
char *__cdecl setlocale(int cat, const char *name) { (void)cat; if (name && *name && strcmp(name, "C") && strcmp(name, "POSIX")) return nullptr; return const_cast<char *>("C"); }
wchar_t *__cdecl _wsetlocale(int cat, const wchar_t *name) { (void)cat; if (name && *name && wcscmp(name, L"C") && wcscmp(name, L"POSIX")) return nullptr; return const_cast<wchar_t *>(L"C"); }
static unsigned short g_ctype[256]; static volatile long g_ctype_ready;
const unsigned short *__cdecl __pctype_func(void) {
    if (!g_ctype_ready) {
        for (int c = 0; c < 256; c++) {
            unsigned short m = 0;
            if (c >= 'A' && c <= 'Z') m |= _UPPER; if (c >= 'a' && c <= 'z') m |= _LOWER; if (c >= '0' && c <= '9') m |= _DIGIT;
            if (c == ' ' || (c >= 9 && c <= 13)) m |= _SPACE; if (c < 32 || c == 127) m |= _CONTROL; if (c == ' ' || c == '\t') m |= _BLANK;
            if ((c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)) m |= _PUNCT;
            if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) m |= _HEX;
            g_ctype[c] = m;
        }
        InterlockedExchange(&g_ctype_ready, 1);
    }
    return g_ctype;
}
/* the UCRT's is a critical section, and the STL takes it re-entrantly (use_facet inside facet construction) */
static CRITICAL_SECTION g_loc_cs; static volatile long g_loc_cs_state;
static void loc_cs_init(void) { for (;;) { long v = g_loc_cs_state; if (v == 2) return; if (v == 0 && InterlockedCompareExchange(&g_loc_cs_state, 1, 0) == 0) { InitializeCriticalSectionEx(&g_loc_cs, 4000, 0); InterlockedExchange(&g_loc_cs_state, 2); return; } ee_sleep_ms(1); } }
void __cdecl _lock_locales(void) { loc_cs_init(); EnterCriticalSection(&g_loc_cs); }
void __cdecl _unlock_locales(void) { LeaveCriticalSection(&g_loc_cs); }

/* ---- Win32 NLS, ASCII semantics ------------------------------------------------------------ */
static int ascii_cmp(const wchar_t *a, int na, const wchar_t *b, int nb, bool nocase) {
    if (na < 0) na = (int)wcslen(a); if (nb < 0) nb = (int)wcslen(b);
    for (int i = 0; i < na && i < nb; i++) { unsigned x = a[i], y = b[i]; if (nocase) { if (x < 128) x = (unsigned)towlower((wint_t)x); if (y < 128) y = (unsigned)towlower((wint_t)y); } if (x != y) return x < y ? CSTR_LESS_THAN : CSTR_GREATER_THAN; }
    return na == nb ? CSTR_EQUAL : na < nb ? CSTR_LESS_THAN : CSTR_GREATER_THAN;
}
BOOL WINAPI GetStringTypeW(DWORD type, LPCWCH src, int n, LPWORD out) {
    if (type != CT_CTYPE1) { SetLastError(ERROR_INVALID_FLAGS); return FALSE; }
    if (n < 0) n = (int)wcslen(src) + 1;
    for (int i = 0; i < n; i++) {
        const unsigned c = src[i]; WORD m = 0;
        if (c < 128) { const unsigned short t = __pctype_func()[c];
            if (t & _UPPER) m |= C1_UPPER; if (t & _LOWER) m |= C1_LOWER; if (t & _DIGIT) m |= C1_DIGIT; if (t & _SPACE) m |= C1_SPACE;
            if (t & _PUNCT) m |= C1_PUNCT; if (t & _CONTROL) m |= C1_CNTRL; if (t & _BLANK) m |= C1_BLANK; if (t & _HEX) m |= C1_XDIGIT; if (t & (_UPPER | _LOWER)) m |= C1_ALPHA; }
        else m = C1_ALPHA | C1_DEFINED;
        out[i] = m;
    }
    return TRUE;
}
int WINAPI LCMapStringEx(LPCWSTR loc, DWORD flags, LPCWSTR src, int n, LPWSTR dst, int cap, LPNLSVERSIONINFO v, LPVOID r, LPARAM s) {
    (void)loc; (void)v; (void)r; (void)s; if (n < 0) n = (int)wcslen(src) + 1;
    if (flags & LCMAP_SORTKEY) { if (cap == 0) return n; if (cap < n) { SetLastError(ERROR_INSUFFICIENT_BUFFER); return 0; } unsigned char *d = (unsigned char *)dst; for (int i = 0; i < n; i++) d[i] = (unsigned char)(src[i] < 256 ? src[i] : '?'); return n; }
    if (cap == 0) return n; if (cap < n) { SetLastError(ERROR_INSUFFICIENT_BUFFER); return 0; }
    for (int i = 0; i < n; i++) { wchar_t c = src[i]; if (c < 128) { if (flags & LCMAP_UPPERCASE) c = (wchar_t)towupper(c); else if (flags & LCMAP_LOWERCASE) c = (wchar_t)towlower(c); } dst[i] = c; }
    return n;
}
int WINAPI LCMapStringW(LCID l, DWORD flags, LPCWSTR src, int n, LPWSTR dst, int cap) { (void)l; return LCMapStringEx(nullptr, flags, src, n, dst, cap, nullptr, nullptr, 0); }
int WINAPI LCMapStringA(LCID l, DWORD flags, LPCSTR src, int n, LPSTR dst, int cap) {
    (void)l; if (n < 0) n = (int)strlen(src) + 1; if (cap == 0) return n; if (cap < n) { SetLastError(ERROR_INSUFFICIENT_BUFFER); return 0; }
    for (int i = 0; i < n; i++) { unsigned char c = (unsigned char)src[i]; if (c < 128 && !(flags & LCMAP_SORTKEY)) { if (flags & LCMAP_UPPERCASE) c = (unsigned char)toupper(c); else if (flags & LCMAP_LOWERCASE) c = (unsigned char)tolower(c); } dst[i] = (char)c; }
    return n;
}
int WINAPI CompareStringEx(LPCWSTR loc, DWORD flags, LPCWCH a, int na, LPCWCH b, int nb, LPNLSVERSIONINFO v, LPVOID r, LPARAM s) { (void)loc; (void)v; (void)r; (void)s; return ascii_cmp(a, na, b, nb, (flags & NORM_IGNORECASE) != 0); }
int WINAPI CompareStringW(LCID l, DWORD flags, LPCWCH a, int na, LPCWCH b, int nb) { (void)l; return ascii_cmp(a, na, b, nb, (flags & NORM_IGNORECASE) != 0); }
int WINAPI GetLocaleInfoEx(LPCWSTR loc, LCTYPE t, LPWSTR d, int n) { (void)loc; (void)t; (void)d; (void)n; SetLastError(ERROR_INVALID_PARAMETER); return 0; }
BOOL WINAPI GetCPInfo(UINT cp, LPCPINFO info) { (void)cp; memset(info, 0, sizeof *info); info->MaxCharSize = 1; info->DefaultChar[0] = '?'; return TRUE; }
HMODULE WINAPI GetModuleHandleW(LPCWSTR n) { (void)n; return NULL; }

/* ---- the STL's own NLS wrappers (StlCompareString*.cpp / StlLCMapString*.cpp), ASCII ------ */
int __cdecl __crtCompareStringA(LPCWSTR loc, DWORD flags, LPCSTR a, int na, LPCSTR b, int nb, int cp) noexcept {
    (void)loc; (void)cp; if (na < 0) na = (int)strlen(a); if (nb < 0) nb = (int)strlen(b); const bool nocase = (flags & NORM_IGNORECASE) != 0;
    for (int i = 0; i < na && i < nb; i++) { unsigned x = (unsigned char)a[i], y = (unsigned char)b[i]; if (nocase && x < 128 && y < 128) { x = (unsigned)tolower((int)x); y = (unsigned)tolower((int)y); } if (x != y) return x < y ? CSTR_LESS_THAN : CSTR_GREATER_THAN; }
    return na == nb ? CSTR_EQUAL : na < nb ? CSTR_LESS_THAN : CSTR_GREATER_THAN;
}
int __cdecl __crtCompareStringW(LPCWSTR loc, DWORD flags, LPCWSTR a, int na, LPCWSTR b, int nb) noexcept { (void)loc; return ascii_cmp(a, na, b, nb, (flags & NORM_IGNORECASE) != 0); }
int __cdecl __crtLCMapStringA(LPCWSTR loc, DWORD flags, LPCSTR src, int n, char *dst, int cap, int cp, BOOL berr) noexcept { (void)loc; (void)cp; (void)berr; return LCMapStringA(0, flags, src, n, dst, cap); }
int __cdecl __crtLCMapStringW(LPCWSTR loc, DWORD flags, LPCWSTR src, int n, wchar_t *dst, int cap) noexcept { (void)loc; return LCMapStringEx(nullptr, flags, src, n, dst, cap, nullptr, nullptr, 0); }
}

/* ---- UCRT calendar names and time formatting, C locale ------------------------------------ */
extern "C" {
char *__cdecl _Getdays(void) { return _strdup(":Sun:Sunday:Mon:Monday:Tue:Tuesday:Wed:Wednesday:Thu:Thursday:Fri:Friday:Sat:Saturday"); }
char *__cdecl _Getmonths(void) { return _strdup(":Jan:January:Feb:February:Mar:March:Apr:April:May:May:Jun:June:Jul:July:Aug:August:Sep:September:Oct:October:Nov:November:Dec:December"); }
void *__cdecl _Gettnames(void) { return nullptr; }
wchar_t *__cdecl _W_Getdays(void) { return _wcsdup(L":Sun:Sunday:Mon:Monday:Tue:Tuesday:Wed:Wednesday:Thu:Thursday:Fri:Friday:Sat:Saturday"); }
wchar_t *__cdecl _W_Getmonths(void) { return _wcsdup(L":Jan:January:Feb:February:Mar:March:Apr:April:May:May:Jun:June:Jul:July:Aug:August:Sep:September:Oct:October:Nov:November:Dec:December"); }
void *__cdecl _W_Gettnames(void) { return nullptr; }
size_t __cdecl _Strftime(char *buf, size_t cap, const char *fmt, const struct tm *t, void *names) { (void)fmt; (void)t; (void)names; if (cap) buf[0] = 0; return 0; }
size_t __cdecl _Wcsftime(wchar_t *buf, size_t cap, const wchar_t *fmt, const struct tm *t, void *names) { (void)fmt; (void)t; (void)names; if (cap) buf[0] = 0; return 0; }
/* ---- std::call_once (the msvcp init-once path) and Win32 InitOnce ------------------------- */
static SRWLOCK g_once_lock = SRWLOCK_INIT;
int __stdcall ee_init_once_begin(void **once, unsigned long flags, int *pending, void **context) {
    (void)flags; (void)context;
    for (;;) { void *v = *once; if (v == (void *)2) { *pending = 0; return 1; }
        if (v == nullptr && InterlockedCompareExchangePointer(once, (void *)1, nullptr) == nullptr) { *pending = 1; return 1; }
        ee_sleep_ms(1); }
}
int __stdcall ee_init_once_complete(void **once, unsigned long flags, void *context) { (void)context; InterlockedExchangePointer(once, (flags & 4 /*INIT_ONCE_INIT_FAILED*/) ? nullptr : (void *)2); return 1; }
void *__imp___std_init_once_begin_initialize = (void *)&ee_init_once_begin;
void *__imp___std_init_once_complete = (void *)&ee_init_once_complete;
void __stdcall __std_init_once_link_alternate_names_and_abort() { ee_fatal("__std_init_once_link_alternate_names_and_abort"); }
BOOL WINAPI InitOnceExecuteOnce(PINIT_ONCE once, PINIT_ONCE_FN fn, PVOID param, LPVOID *ctx) {
    int pending = 0; ee_init_once_begin(&once->Ptr, 0, &pending, ctx);
    if (pending) { const BOOL ok = fn(once, param, ctx); ee_init_once_complete(&once->Ptr, ok ? 0 : 4, ctx ? *ctx : nullptr); return ok; }
    return TRUE;
}
/* ---- odds and ends the sources reach for --------------------------------------------------- */
BOOL WINAPI SetThreadInformation(HANDLE h, THREAD_INFORMATION_CLASS c, LPVOID p, DWORD n) { (void)h; (void)c; (void)p; (void)n; return TRUE; }
BOOL WINAPI GlobalMemoryStatusEx(LPMEMORYSTATUSEX m) { memset(m, 0, sizeof *m); m->dwLength = sizeof *m; m->ullTotalPhys = m->ullAvailPhys = 2ull << 30; m->ullTotalVirtual = m->ullAvailVirtual = 2ull << 30; return TRUE; }
LSTATUS APIENTRY RegOpenKeyExA(HKEY k, LPCSTR s, DWORD o, REGSAM a, PHKEY r) { (void)k; (void)s; (void)o; (void)a; *r = nullptr; return ERROR_FILE_NOT_FOUND; }
LSTATUS APIENTRY RegQueryValueExA(HKEY k, LPCSTR n, LPDWORD r, LPDWORD t, LPBYTE d, LPDWORD c) { (void)k; (void)n; (void)r; (void)t; (void)d; (void)c; return ERROR_FILE_NOT_FOUND; }
LSTATUS APIENTRY RegCloseKey(HKEY k) { (void)k; return ERROR_SUCCESS; }
static void (__cdecl *g_terminate)(void);
void (__cdecl *__cdecl set_terminate(void (__cdecl *f)(void)))(void) { void (__cdecl *o)(void) = g_terminate; g_terminate = f; return o; }
}
namespace std { unsigned int __cdecl _Random_device() { unsigned int v = 0; ee_random(&v, sizeof v); return v; } }
void __cdecl _Atexit(void (__cdecl *f)(void)) { atexit(f); }   /* C++ linkage, global namespace: how <xutility> declares it */
