package app

// FENCING PATCH (test only): internals the black-box fence tests need to build raw signed requests.

var (
	// Sign is sign.
	Sign = sign
	// RequestHash is the 0.6.0 request hash.
	RequestHash = requestHash
	// FencedRequestHash is the fenced request hash.
	FencedRequestHash = fencedRequestHash
)
