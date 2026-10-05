// Package guard provides a fail-closed SOCKS5 TCP transport for TUNA clients.
// Resolution of target hostnames is performed by the SOCKS provider, not locally.
package guard

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"
)

type Dialer struct{ Address string }

func New(address string) (*Dialer, error) {
	host, port, err := net.SplitHostPort(address)
	p, pe := strconv.Atoi(port)
	if err != nil || net.ParseIP(host) == nil || pe != nil || p < 1 || p > 65535 {
		return nil, errors.New("guard endpoint must be a literal IP and TCP port")
	}
	return &Dialer{Address: address}, nil
}

func (d *Dialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	if network != "tcp" && network != "tcp4" && network != "tcp6" {
		return nil, errors.New("guard supports TCP only; direct fallback forbidden")
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	p, err := strconv.Atoi(port)
	if err != nil || p < 1 || p > 65535 {
		return nil, errors.New("invalid destination port")
	}
	request := []byte{5, 1, 0}
	ip := net.ParseIP(host)
	if ip4 := ip.To4(); ip4 != nil {
		request = append(request, 1)
		request = append(request, ip4...)
	} else if ip != nil {
		request = append(request, 4)
		request = append(request, ip.To16()...)
	} else {
		if len(host) == 0 || len(host) > 255 || strings.ContainsAny(host, "\x00\r\n\t %") {
			return nil, errors.New("invalid destination hostname")
		}
		request = append(request, 3, byte(len(host)))
		request = append(request, host...)
	}
	request = binary.BigEndian.AppendUint16(request, uint16(p))
	c, err := (&net.Dialer{}).DialContext(ctx, "tcp", d.Address)
	if err != nil {
		return nil, fmt.Errorf("guard unavailable: %w", err)
	}
	ok := false
	defer func() {
		if !ok {
			c.Close()
		}
	}()
	stopCancel := context.AfterFunc(ctx, func() { c.Close() })
	defer stopCancel()
	if deadline, yes := ctx.Deadline(); yes {
		c.SetDeadline(deadline)
	}
	if _, err = c.Write([]byte{5, 1, 0}); err != nil {
		return nil, err
	}
	var greeting [2]byte
	if _, err = io.ReadFull(c, greeting[:]); err != nil {
		return nil, err
	}
	if greeting != [2]byte{5, 0} {
		return nil, errors.New("guard refused SOCKS authentication")
	}
	if _, err = c.Write(request); err != nil {
		return nil, err
	}
	var header [4]byte
	if _, err = io.ReadFull(c, header[:]); err != nil {
		return nil, err
	}
	if header[0] != 5 || header[1] != 0 || header[2] != 0 {
		return nil, fmt.Errorf("guard refused destination (status %d)", header[1])
	}
	var size int
	switch header[3] {
	case 1:
		size = 4
	case 4:
		size = 16
	case 3:
		var b [1]byte
		if _, err = io.ReadFull(c, b[:]); err != nil {
			return nil, err
		}
		size = int(b[0])
	default:
		return nil, errors.New("invalid guard reply address type")
	}
	if _, err = io.CopyN(io.Discard, c, int64(size+2)); err != nil {
		return nil, err
	}
	if !stopCancel() || ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err = c.SetDeadline(time.Time{}); err != nil {
		return nil, err
	}
	ok = true
	return c, nil
}
