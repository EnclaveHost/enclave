module enclave.host/isolation/m3

go 1.24

require (
	enclave.host/isolation/contract v0.0.0
	enclave.host/isolation/m2 v0.0.0
)

replace enclave.host/isolation/contract => ../contract

replace enclave.host/isolation/m2 => ../m2

require (
 github.com/decred/dcrd/dcrec/secp256k1/v4 v4.4.1 // indirect
 golang.org/x/crypto v0.37.0 // indirect
)
