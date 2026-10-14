//go:build !amd64

package main

func cpuid(leaf, sub uint32) (eax, ebx, ecx, edx uint32) { return 0, 0, 0, 0 }

const haveCPUID = false
