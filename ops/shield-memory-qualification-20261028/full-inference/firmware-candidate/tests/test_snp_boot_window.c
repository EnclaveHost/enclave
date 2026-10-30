/*
 * Offline tests for SnpBootWindow.h and for a statement-by-statement model of
 * the candidate AmdSevSnpInitialize() resource-HOB walk. NOT RUN YET.
 *
 * Build and run (host compiler, no edk2, no privileges; see BUILD-RECIPE.md):
 *   cc -std=c11 -O1 -g -Wall -Wextra -Werror -fsanitize=address,undefined \
 *      -I../src/OvmfPkg/PlatformPei -o "$OUT/snpwin-test" test_snp_boot_window.c
 *   "$OUT/snpwin-test"      # exit 0 and "ALL PASS" on success
 */
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

typedef uint64_t UINT64;
#define STATIC  static
#define IN
#define OUT
#define SIZE_4KB       0x1000ULL
#define SIZE_1GB       0x40000000ULL
#define SIZE_2GB       0x80000000ULL
#define SIZE_4GB       0x100000000ULL
#define EFI_PAGE_MASK  0xFFFULL
#define MAX_UINT64     0xFFFFFFFFFFFFFFFFULL

#include "SnpBootWindow.h"

typedef unsigned __int128 U128;

static int  failures;
static int  checks;
#define CHECK(c)                                                          \
  do {                                                                    \
    checks++;                                                             \
    if (!(c)) {                                                           \
      failures++;                                                         \
      fprintf (stderr, "%s:%d: [%s] CHECK failed: %s\n", __FILE__,        \
               __LINE__, CurrentCase, #c);                                \
    }                                                                     \
  } while (0)

static const char  *CurrentCase = "";

/* ---- 1. Pure helper against an independent 128-bit reference ---------- */

static SNP_BOOT_WINDOW_ACTION
Reference (UINT64 Start, UINT64 Length, UINT64 Remaining, UINT64 *Head)
{
  U128  s = Start;
  U128  e = (U128)Start + Length;
  U128  hi = SNP_BOOT_WINDOW_LIMIT;
  U128  top;

  *Head = 0;
  if (Start < SNP_BOOT_WINDOW_BASE) return SnpBootWindowDeferAll;
  if ((Length == 0) || (Start % SIZE_4KB) || (Length % SIZE_4KB)) return SnpBootWindowDeferAll;
  if (e > (U128)MAX_UINT64) return SnpBootWindowDeferAll;
  top = (e < hi) ? e : hi;
  if (top <= s) return SnpBootWindowDeferAll;
  if (top - s > Remaining) return SnpBootWindowDeferAll;
  *Head = (UINT64)(top - s);
  return (*Head == Length) ? SnpBootWindowAcceptAll : SnpBootWindowSplit;
}

static void
TestClassifyGrid (void)
{
  static const UINT64  Starts[] = {
    0, SIZE_2GB, SIZE_4GB - SIZE_4KB, SIZE_4GB, SIZE_4GB + 1, SIZE_4GB + SIZE_4KB,
    SIZE_4GB + SIZE_1GB, SIZE_4GB + SIZE_1GB + SIZE_1GB / 2,
    SNP_BOOT_WINDOW_LIMIT - 2 * SIZE_4KB, SNP_BOOT_WINDOW_LIMIT - SIZE_4KB,
    SNP_BOOT_WINDOW_LIMIT - 1, SNP_BOOT_WINDOW_LIMIT, SNP_BOOT_WINDOW_LIMIT + SIZE_4KB,
    1ULL << 63, MAX_UINT64 - 0xFFF, MAX_UINT64
  };
  static const UINT64  Lengths[] = {
    0, 1, SIZE_4KB - 1, SIZE_4KB, 2 * SIZE_4KB, SIZE_4KB + 1, SIZE_1GB / 2, SIZE_1GB,
    SIZE_2GB - SIZE_4KB, SIZE_2GB, SIZE_2GB + SIZE_4KB, 54 * SIZE_1GB, 1ULL << 63,
    MAX_UINT64 - SNP_BOOT_WINDOW_BASE - 0xFFF, MAX_UINT64 - SNP_BOOT_WINDOW_BASE + 1,
    MAX_UINT64 - 0xFFF, MAX_UINT64
  };
  static const UINT64  Remainings[] = { 0, SIZE_4KB, SIZE_1GB, SIZE_2GB - SIZE_4KB, SIZE_2GB };
  size_t  i, j, k;

  CurrentCase = "classify-grid";
  for (i = 0; i < sizeof Starts / sizeof Starts[0]; i++) {
    for (j = 0; j < sizeof Lengths / sizeof Lengths[0]; j++) {
      for (k = 0; k < sizeof Remainings / sizeof Remainings[0]; k++) {
        UINT64                  H = 0xdead, R = 0xbeef;
        SNP_BOOT_WINDOW_ACTION  A = SnpBootWindowClassify (Starts[i], Lengths[j], Remainings[k], &H);
        SNP_BOOT_WINDOW_ACTION  E = Reference (Starts[i], Lengths[j], Remainings[k], &R);

        CHECK (A == E);
        CHECK (H == R);
        if (A == SnpBootWindowDeferAll) {
          CHECK (H == 0);
        } else {
          CHECK (H > 0);
          CHECK ((H & EFI_PAGE_MASK) == 0);
          CHECK (H <= Lengths[j]);
          CHECK (H <= Remainings[k]);
          CHECK (Starts[i] >= SNP_BOOT_WINDOW_BASE);
          CHECK ((U128)Starts[i] + H <= SNP_BOOT_WINDOW_LIMIT);
          CHECK ((A == SnpBootWindowAcceptAll) == (H == Lengths[j]));
        }
      }
    }
  }
}

/* ---- 2. Model of the candidate HOB walk -------------------------------- */

enum { T_SYSTEM_MEMORY = 0, T_MMIO = 1, T_UNACCEPTED = 7 };   /* PI values */
#define A_TESTED           0x00000100ULL
#define A_SPECIAL_PURPOSE  0x00040000ULL
#define MAX_HOBS           32

typedef struct { int Type; UINT64 Attr; UINT64 Start; UINT64 Length; int Origin; } MODEL_HOB;
typedef struct { UINT64 Start; UINT64 Length; } RANGE;

typedef struct {
  MODEL_HOB  Hob[MAX_HOBS];
  int        Count;
  int        Capacity;           /* HOB space; appends beyond it fail */
  RANGE      Validated[MAX_HOBS];
  int        ValidatedCount;
} MODEL;

/* Mirrors the candidate loop in AmdSev.c; keep the two in step. */
static void
ModelWalk (MODEL *M)
{
  UINT64                  WindowRemaining = SNP_BOOT_WINDOW_LIMIT - SNP_BOOT_WINDOW_BASE;
  UINT64                  WindowAcceptedEnd = SNP_BOOT_WINDOW_BASE;
  UINT64                  HeadLength;
  SNP_BOOT_WINDOW_ACTION  WindowAction;
  int                     EndOfHobList;
  int                     i;

  for (i = 0; i < M->Count; i++) {               /* Count grows when tails are appended */
    MODEL_HOB  *R = &M->Hob[i];

    if (R->Type != T_SYSTEM_MEMORY) continue;
    if ((R->Start >= SIZE_4GB) && ((R->Attr & A_SPECIAL_PURPOSE) == 0)) {
      WindowAction = SnpBootWindowDeferAll;
      if (R->Start >= WindowAcceptedEnd) {
        WindowAction = SnpBootWindowClassify (R->Start, R->Length, WindowRemaining, &HeadLength);
      }
      if (WindowAction == SnpBootWindowSplit) {
        EndOfHobList = M->Count;
        if (M->Count < M->Capacity) {
          MODEL_HOB  Tail = { T_UNACCEPTED, R->Attr, R->Start + HeadLength, R->Length - HeadLength, R->Origin };
          M->Hob[M->Count++] = Tail;
        }
        if (M->Count == EndOfHobList) {
          WindowAction = SnpBootWindowDeferAll;
        } else {
          R->Length = HeadLength;
        }
      }
      if (WindowAction == SnpBootWindowDeferAll) {
        R->Type = T_UNACCEPTED;
        continue;
      }
      WindowRemaining -= HeadLength;
      WindowAcceptedEnd = R->Start + HeadLength;
    }
    /* MemEncryptSevSnpPreValidateSystemRam (Start, EFI_SIZE_TO_PAGES (Length)) */
    M->Validated[M->ValidatedCount].Start  = R->Start;
    M->Validated[M->ValidatedCount].Length = (R->Length + EFI_PAGE_MASK) & ~EFI_PAGE_MASK;
    M->ValidatedCount++;
  }
}

static int
CountValidated (const MODEL *M, UINT64 Start, UINT64 Length)
{
  int  i, n = 0;
  for (i = 0; i < M->ValidatedCount; i++) {
    if ((M->Validated[i].Start == Start) && (M->Validated[i].Length == Length)) n++;
  }
  return n;
}

static int
IntersectsValidated (const MODEL *M, UINT64 Start, UINT64 Length)
{
  int  i;
  for (i = 0; i < M->ValidatedCount; i++) {
    U128  vs = M->Validated[i].Start, ve = vs + M->Validated[i].Length;
    if ((vs < (U128)Start + Length) && ((U128)Start < ve)) return 1;
  }
  return 0;
}

/* Generic invariants. Returns the number of HOBs appended. */
static int
CheckWalk (const MODEL_HOB *In, int InCount, int Capacity, MODEL *M)
{
  int   i, j;
  U128  HighValidated = 0;

  memset (M, 0, sizeof *M);
  for (i = 0; i < InCount; i++) { M->Hob[i] = In[i]; M->Hob[i].Origin = i; }
  M->Count    = InCount;
  M->Capacity = Capacity;
  ModelWalk (M);

  /* Appended HOBs are only unaccepted tails, so none is ever re-processed. */
  for (j = InCount; j < M->Count; j++) CHECK (M->Hob[j].Type == T_UNACCEPTED);

  for (i = 0; i < InCount; i++) {
    const MODEL_HOB  *I = &In[i];
    const MODEL_HOB  *O = &M->Hob[i];
    const MODEL_HOB  *Tail = NULL;
    int               Tails = 0;

    for (j = InCount; j < M->Count; j++) {
      if (M->Hob[j].Origin == i) { Tail = &M->Hob[j]; Tails++; }
    }
    CHECK (Tails <= 1);
    CHECK (O->Start == I->Start);
    CHECK (O->Attr == I->Attr);

    if (I->Type != T_SYSTEM_MEMORY) {
      /* Non-RAM and already-unaccepted HOBs: untouched. */
      CHECK (O->Type == I->Type && O->Length == I->Length);
      CHECK (Tails == 0);
    } else if ((I->Start < SIZE_4GB) || (I->Attr & A_SPECIAL_PURPOSE)) {
      /* Below 4GB and Specific Purpose: original behaviour exactly. */
      CHECK (O->Type == T_SYSTEM_MEMORY && O->Length == I->Length);
      CHECK (Tails == 0);
      CHECK (CountValidated (M, I->Start, (I->Length + EFI_PAGE_MASK) & ~EFI_PAGE_MASK) >= 1);
    } else {
      /* Ordinary RAM at/above 4GB: tiles exactly, head inside the window. */
      U128  End = (U128)O->Start + O->Length;
      if (Tail != NULL) {
        CHECK ((U128)Tail->Start == End);                 /* no gap, no overlap */
        CHECK ((U128)Tail->Start + Tail->Length == (U128)I->Start + I->Length);
        CHECK (Tail->Attr == I->Attr);
        CHECK (Tail->Length > 0);
        CHECK (!IntersectsValidated (M, Tail->Start, Tail->Length));
        CHECK (O->Type == T_SYSTEM_MEMORY);
      } else {
        CHECK (O->Length == I->Length);
      }
      if (O->Type == T_SYSTEM_MEMORY) {
        CHECK (End <= SNP_BOOT_WINDOW_LIMIT);
        CHECK (CountValidated (M, O->Start, O->Length) == 1);    /* never twice */
        HighValidated += O->Length;
      } else {
        CHECK (O->Type == T_UNACCEPTED);
        CHECK (O->Length == I->Length);                   /* defer-all keeps the HOB whole */
      }
    }
  }
  CHECK (HighValidated <= SNP_BOOT_WINDOW_LIMIT - SNP_BOOT_WINDOW_BASE);
  return M->Count - InCount;
}

#define HOB(t, a, s, l)  { (t), (a), (s), (l), 0 }
#define N(x)             ((int)(sizeof (x) / sizeof ((x)[0])))
#define GB(x)            ((UINT64)(x) * SIZE_1GB)

static void
TestWalks (void)
{
  MODEL  M;
  int    Appended;

  CurrentCase = "q35-4GiB (T1 shape): high RAM is exactly the window";
  {
    MODEL_HOB  In[] = { HOB (T_SYSTEM_MEMORY, A_TESTED, 0, SIZE_2GB),
                        HOB (T_SYSTEM_MEMORY, A_TESTED, SIZE_4GB, SIZE_2GB) };
    Appended = CheckWalk (In, N (In), MAX_HOBS, &M);
    CHECK (Appended == 0);
    CHECK (M.Hob[1].Type == T_SYSTEM_MEMORY && M.Hob[1].Length == SIZE_2GB);
    CHECK (M.ValidatedCount == 2);
  }

  CurrentCase = "q35-56GiB (bench shape): split at 6GiB";
  {
    MODEL_HOB  In[] = { HOB (T_SYSTEM_MEMORY, A_TESTED, 0, SIZE_2GB),
                        HOB (T_MMIO, 0, 0xE0000000ULL, 0x10000000ULL),
                        HOB (T_SYSTEM_MEMORY, A_TESTED, SIZE_4GB, GB (54)) };
    Appended = CheckWalk (In, N (In), MAX_HOBS, &M);
    CHECK (Appended == 1);
    CHECK (M.Hob[2].Length == SIZE_2GB);
    CHECK (M.Hob[3].Start == SNP_BOOT_WINDOW_LIMIT && M.Hob[3].Length == GB (52));
  }

  CurrentCase = "short ranges and nonstandard starts";
  {
    MODEL_HOB  In[] = { HOB (T_SYSTEM_MEMORY, A_TESTED, SIZE_4GB, SIZE_4KB),
                        HOB (T_SYSTEM_MEMORY, A_TESTED, SIZE_4GB + SIZE_1GB + SIZE_1GB / 2, SIZE_1GB),
                        HOB (T_SYSTEM_MEMORY, A_TESTED, GB (7), SIZE_1GB) };
    Appended = CheckWalk (In, N (In), MAX_HOBS, &M);
    CHECK (Appended == 1);
    CHECK (M.Hob[1].Length == SIZE_1GB / 2);
    CHECK (M.Hob[2].Type == T_UNACCEPTED);
  }

  CurrentCase = "one page straddling the limit";
  {
    MODEL_HOB  In[] = { HOB (T_SYSTEM_MEMORY, A_TESTED, SNP_BOOT_WINDOW_LIMIT - SIZE_4KB, 2 * SIZE_4KB) };
    Appended = CheckWalk (In, N (In), MAX_HOBS, &M);
    CHECK (Appended == 1 && M.Hob[0].Length == SIZE_4KB && M.Hob[1].Length == SIZE_4KB);
  }

  CurrentCase = "malformed: unaligned start, unaligned length, zero length, overflow";
  {
    MODEL_HOB  In[] = { HOB (T_SYSTEM_MEMORY, A_TESTED, SIZE_4GB + 1, SIZE_1GB),
                        HOB (T_SYSTEM_MEMORY, A_TESTED, SIZE_4GB + GB (1), SIZE_4KB + 1),
                        HOB (T_SYSTEM_MEMORY, A_TESTED, SIZE_4GB + SIZE_4KB, 0),
                        HOB (T_SYSTEM_MEMORY, A_TESTED, GB (5), MAX_UINT64 - GB (5) + 1) };
    Appended = CheckWalk (In, N (In), MAX_HOBS, &M);
    CHECK (Appended == 0);
    CHECK (M.ValidatedCount == 0);
  }

  CurrentCase = "two HOBs inside the window share the 2GiB budget";
  {
    MODEL_HOB  In[] = { HOB (T_SYSTEM_MEMORY, A_TESTED, SIZE_4GB, SIZE_1GB),
                        HOB (T_SYSTEM_MEMORY, A_TESTED, GB (5), GB (2)) };
    Appended = CheckWalk (In, N (In), MAX_HOBS, &M);
    CHECK (Appended == 1 && M.Hob[1].Length == SIZE_1GB);
  }

  CurrentCase = "duplicate (overlapping) HOBs: budget refuses the second";
  {
    MODEL_HOB  In[] = { HOB (T_SYSTEM_MEMORY, A_TESTED, SIZE_4GB, GB (8)),
                        HOB (T_SYSTEM_MEMORY, A_TESTED, SIZE_4GB, GB (8)) };
    Appended = CheckWalk (In, N (In), MAX_HOBS, &M);
    CHECK (Appended == 1 && M.Hob[1].Type == T_UNACCEPTED && M.ValidatedCount == 1);
  }

  CurrentCase = "special purpose above 4GiB, sub-4GiB crossing 4GiB, pre-existing unaccepted";
  {
    MODEL_HOB  In[] = { HOB (T_SYSTEM_MEMORY, A_TESTED | A_SPECIAL_PURPOSE, GB (8), GB (16)),
                        HOB (T_SYSTEM_MEMORY, A_TESTED, GB (3), GB (2)),
                        HOB (T_UNACCEPTED, A_TESTED, GB (40), GB (1)),
                        HOB (T_SYSTEM_MEMORY, A_TESTED, GB (4) + GB (1), GB (1)) };
    Appended = CheckWalk (In, N (In), MAX_HOBS, &M);
    CHECK (Appended == 0);
    CHECK (CountValidated (&M, GB (8), GB (16)) == 1);
    CHECK (CountValidated (&M, GB (3), GB (2)) == 1);
    CHECK (M.Hob[2].Type == T_UNACCEPTED && !IntersectsValidated (&M, GB (40), GB (1)));
  }

  CurrentCase = "short duplicate fits remaining budget but must not be validated twice";
  {
    MODEL_HOB In[] = { HOB (T_SYSTEM_MEMORY, A_TESTED, GB (4), SIZE_1GB / 2),
                       HOB (T_SYSTEM_MEMORY, A_TESTED, GB (4), SIZE_1GB / 2) };
    Appended = CheckWalk (In, N (In), MAX_HOBS, &M);
    CHECK (Appended == 0 && M.ValidatedCount == 1 && M.Hob[1].Type == T_UNACCEPTED);
  }

  CurrentCase = "out-of-order high heads defer conservatively";
  {
    MODEL_HOB In[] = { HOB (T_SYSTEM_MEMORY, A_TESTED, GB (5), SIZE_1GB / 2),
                       HOB (T_SYSTEM_MEMORY, A_TESTED, GB (4), SIZE_1GB / 2) };
    Appended = CheckWalk (In, N (In), MAX_HOBS, &M);
    CHECK (Appended == 0 && M.ValidatedCount == 1 && M.Hob[1].Type == T_UNACCEPTED);
  }

  CurrentCase = "HOB space exhausted: fall back to defer-all, no memory lost";
  {
    MODEL_HOB  In[] = { HOB (T_SYSTEM_MEMORY, A_TESTED, 0, SIZE_2GB),
                        HOB (T_SYSTEM_MEMORY, A_TESTED, SIZE_4GB, GB (54)) };
    Appended = CheckWalk (In, N (In), N (In), &M);
    CHECK (Appended == 0);
    CHECK (M.Hob[1].Type == T_UNACCEPTED && M.Hob[1].Length == GB (54));
    CHECK (M.ValidatedCount == 1);
  }
}

int
main (void)
{
  TestClassifyGrid ();
  TestWalks ();
  if (failures != 0) {
    fprintf (stderr, "FAILED %d of %d checks\n", failures, checks);
    return 1;
  }
  printf ("ALL PASS (%d checks)\n", checks);
  return 0;
}
