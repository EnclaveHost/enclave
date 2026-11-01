//go:build native_rpc && (!bootstrapdirect || !shielddirect || releaselab)

package main

// Native RPC has no legacy relay, SNP substitution or lab release mode.
var _ = nativeRPCRequiresOwnerDirectShieldBuild
