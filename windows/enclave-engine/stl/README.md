# STL runtime sources for the enclave build

An enclave links libcmt and libvcruntime but no libcpmt: the C++ standard library's runtime half
(locales, iostream bases, `_Lockit`, regex helpers, the vectorised algorithms) is missing.
These files are that half, taken unmodified from github.com/microsoft/STL (4c239c6f99fa (the last commit at
`_MSVC_STL_UPDATE` 202604, the box's toolset's own update; compiled as C++20 like the library itself),
Apache-2.0 WITH LLVM-exception (LICENSE.txt). What they need from Win32 and the UCRT that VTL1
does not offer is supplied by ../ee-stl-support.cpp (NLS functions answer for the "C" locale).
