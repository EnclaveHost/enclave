package app

// FENCING PATCH (test only): internals the black-box fence tests need to build raw signed requests.

var (
	// Sign is sign.
	Sign = sign
	// RequestHash is the 0.6.0 request hash.
	RequestHash = requestHash
	// FencedRequestHash is the fenced request hash.
	FencedRequestHash = fencedRequestHash
	// V4RequestHash is the G-C2 v4 request hash.
	V4RequestHash = v4RequestHash
	// OpDigest is the G-C2 operation digest.
	OpDigest = opDigest
)
