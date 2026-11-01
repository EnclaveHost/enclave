package rclonecrypt

// The entry points encvol uses, beside the vendored cipher.go (not part of rclone; see NOTICE). They construct the
// cipher exactly as rclone's crypt backend does for an env-configured remote: the REVEALED password and password2
// (salt) - rclone's config holds them obscured and reveals them first - with the default "base32" file name encoding.

import (
	"io"
)

// New is rclone's crypt backend construction: filename_encryption (standard|off|obfuscate),
// directory_name_encryption, password, password2 ("" = rclone's default salt), filename_encoding base32.
func New(filenameEncryption string, dirNameEncrypt bool, password, salt string) (*Cipher, error) {
	mode, err := NewNameEncryptionMode(filenameEncryption)
	if err != nil {
		return nil, err
	}
	enc, err := NewNameEncoding("base32")
	if err != nil {
		return nil, err
	}
	return newCipher(mode, password, salt, dirNameEncrypt, enc)
}

// Forget zeroes the derived keys (a locked volume keeps no key material); the cipher is unusable afterwards.
func (c *Cipher) Forget() {
	for i := range c.dataKey {
		c.dataKey[i] = 0
	}
	for i := range c.nameKey {
		c.nameKey[i] = 0
	}
	for i := range c.nameTweak {
		c.nameTweak[i] = 0
	}
	c.block = nil
}

// NonceSize is the per-file nonce rclone writes after its magic.
const NonceSize = fileNonceSize

// EncryptDataNonce is EncryptData with the file nonce given rather than drawn: the same plaintext and nonce give the
// same ciphertext, so an upload can be hashed in one pass and sent in a second without holding the ciphertext.
// The caller draws the nonce at random, once per upload, exactly as EncryptData would.
func (c *Cipher) EncryptDataNonce(in io.Reader, n [NonceSize]byte) (io.Reader, error) {
	nn := nonce(n)
	return c.newEncrypter(in, &nn)
}
