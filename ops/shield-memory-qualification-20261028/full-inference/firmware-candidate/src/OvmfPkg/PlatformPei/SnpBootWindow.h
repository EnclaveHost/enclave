/** @file
  SEV-SNP boot window: the bounded range of ordinary RAM above 4GB that
  PlatformPei pre-validates so boot-services allocations can use it.

  CANDIDATE, NOT UPSTREAM. Pure range arithmetic, no side effects, so that it
  can be compiled and tested offline (see firmware-candidate/tests).

  SPDX-License-Identifier: BSD-2-Clause-Patent

**/

#ifndef SNP_BOOT_WINDOW_H_
#define SNP_BOOT_WINDOW_H_

//
// Absolute window [4GB, 6GB). Only ordinary SYSTEM_MEMORY resource HOBs that
// start at or above 4GB are classified; memory below 4GB and Specific Purpose
// Memory keep their original handling and never reach this helper.
//
#define SNP_BOOT_WINDOW_BASE   SIZE_4GB
#define SNP_BOOT_WINDOW_LIMIT  (SIZE_4GB + SIZE_2GB)

typedef enum {
  //
  // Leave the whole range unaccepted (the original behaviour).
  //
  SnpBootWindowDeferAll,
  //
  // The whole range lies inside the window: pre-validate all of it.
  //
  SnpBootWindowAcceptAll,
  //
  // Pre-validate the head [Start, Start + HeadLength); the tail
  // [Start + HeadLength, Start + Length) is left unaccepted.
  //
  SnpBootWindowSplit
} SNP_BOOT_WINDOW_ACTION;

/**
  Classify one resource range against the boot window.

  @param[in]  Start       PhysicalStart of the resource HOB.
  @param[in]  Length      ResourceLength of the resource HOB.
  @param[in]  Remaining   Window bytes not yet pre-validated by earlier HOBs.
  @param[out] HeadLength  Bytes to pre-validate from Start. Zero for
                          SnpBootWindowDeferAll.

  @return The action. Any range that is below the window base, empty, not
          page aligned, overflowing, starting at or beyond the window limit,
          or whose head exceeds Remaining is SnpBootWindowDeferAll.
**/
STATIC
SNP_BOOT_WINDOW_ACTION
SnpBootWindowClassify (
  IN  UINT64  Start,
  IN  UINT64  Length,
  IN  UINT64  Remaining,
  OUT UINT64  *HeadLength
  )
{
  UINT64  End;
  UINT64  Head;

  *HeadLength = 0;

  if ((Start < SNP_BOOT_WINDOW_BASE) || (Start >= SNP_BOOT_WINDOW_LIMIT)) {
    return SnpBootWindowDeferAll;
  }

  if ((Length == 0) || (((Start | Length) & EFI_PAGE_MASK) != 0)) {
    return SnpBootWindowDeferAll;
  }

  if (Length > MAX_UINT64 - Start) {
    return SnpBootWindowDeferAll;
  }

  End  = Start + Length;
  Head = (End <= SNP_BOOT_WINDOW_LIMIT) ? Length : SNP_BOOT_WINDOW_LIMIT - Start;

  if (Head > Remaining) {
    return SnpBootWindowDeferAll;
  }

  *HeadLength = Head;
  return (Head == Length) ? SnpBootWindowAcceptAll : SnpBootWindowSplit;
}

#endif
