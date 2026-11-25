module enclave.host/isolation/vmboot

go 1.24

require (
	enclave.host/isolation/m2 v0.0.0
	enclave.host/isolation/m3 v0.0.0
)

require enclave.host/isolation/contract v0.0.0 // indirect

replace enclave.host/isolation/contract => ../contract

replace enclave.host/isolation/m2 => ../m2

replace enclave.host/isolation/m3 => ../m3
