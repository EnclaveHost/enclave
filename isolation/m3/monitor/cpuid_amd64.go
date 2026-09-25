package main

// cpuid executes CPUID with EAX=leaf, ECX=sub (cpuid_amd64.s).
func cpuid(leaf, sub uint32) (eax, ebx, ecx, edx uint32)

const haveCPUID = true
