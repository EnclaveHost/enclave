module github.com/EnclaveHost/enclave/network/tuna

go 1.23

require (
	github.com/nknorg/nkn-sdk-go v1.4.8-0.20240427043332-a40386d2b50a
	github.com/nknorg/tuna v0.0.0-20240606122630-7e0f776a7c3b
	github.com/xtaci/smux v2.0.1+incompatible
	google.golang.org/protobuf v1.33.0
)

require (
	github.com/golang/protobuf v1.5.3 // indirect
	github.com/gorilla/websocket v1.5.0 // indirect
	github.com/hashicorp/errwrap v1.1.0 // indirect
	github.com/hashicorp/go-multierror v1.1.1 // indirect
	github.com/imdario/mergo v0.3.13 // indirect
	github.com/itchyny/base58-go v0.2.1 // indirect
	github.com/jpillora/backoff v1.0.0 // indirect
	github.com/nknorg/encrypted-stream v1.0.2-0.20230320101720-9891f770de86 // indirect
	github.com/nknorg/ncp-go v1.0.5 // indirect
	github.com/nknorg/nkn/v2 v2.2.0 // indirect
	github.com/nknorg/nkngomobile v0.0.0-20220615081414-671ad1afdfa9 // indirect
	github.com/oschwald/geoip2-golang v1.4.0 // indirect
	github.com/oschwald/maxminddb-golang v1.6.0 // indirect
	github.com/patrickmn/go-cache v2.1.0+incompatible // indirect
	github.com/pbnjay/memory v0.0.0-20210728143218-7b4eea64cf58 // indirect
	github.com/pkg/errors v0.9.1 // indirect
	github.com/rdegges/go-ipify v0.0.0-20150526035502-2d94a6a86c40 // indirect
	golang.org/x/crypto v0.17.0 // indirect
	golang.org/x/mobile v0.0.0-20230301163155-e0f57694e12c // indirect
	golang.org/x/sys v0.15.0 // indirect
)

// Pin the client transport fixes with the application.
replace github.com/nknorg/tuna => ./upstream

replace github.com/nknorg/nkn-sdk-go => ./nkn-sdk
