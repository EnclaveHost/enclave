module enclave.host/isolation/m4/guestd

go 1.24

require (
	enclave.host/isolation/contract v0.0.0
	enclave.host/isolation/m2 v0.0.0
)

replace (
	enclave.host/isolation/contract => ../../contract
	enclave.host/isolation/m2 => ../../m2
)
