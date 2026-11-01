package rclonecrypt

// Stand-ins for the rclone helpers cipher.go used (see NOTICE):
//   rangeSeeker   fs.RangeSeeker (an interface: the seek path is kept but nothing here calls it)
//   logf          fs.Errorf (rclone logs and carries on in the two places it is used; nothing is logged here)
//   unWrap        accounting.UnWrap (no accounting wrapper exists here: the reader passes through)
//   readFill      lib/readers.ReadFill, verbatim below

import (
	"context"
	"io"
)

type rangeSeeker interface {
	RangeSeek(ctx context.Context, offset int64, whence int, length int64) (int64, error)
}

func logf(string, ...any) {}

func unWrap(in io.Reader) (io.Reader, func(io.Reader) io.Reader) {
	return in, func(r io.Reader) io.Reader { return r }
}

// readFill is rclone v1.67.0 lib/readers/readfill.go ReadFill, verbatim.
// ReadFill reads as much data from r into buf as it can
//
// It reads until the buffer is full or r.Read returned an error.
//
// This is io.ReadFull but when you just want as much data as
// possible, not an exact size of block.
func readFill(r io.Reader, buf []byte) (n int, err error) {
	var nn int
	for n < len(buf) && err == nil {
		nn, err = r.Read(buf[n:])
		n += nn
	}
	return n, err
}
