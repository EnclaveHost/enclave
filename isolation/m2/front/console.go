package main

// The console guard. Everything this process writes reaches the domain console, and the console is the HOST's: the
// serial file on SEV-SNP (guestd's <unit>.serial), the monitor console on the NucBox. The front's own lines are all
// `DOM …` statements, written to carry nothing of a tenant's (reviewed line by line). Other writers are not written
// that way:
//   - net/http's Transport logs an app's unsolicited bytes: an answer to HEAD that carries a body, bytes after a
//     Content-Length, a late response on an idle connection ("Unsolicited response received on idle HTTP channel
//     starting with %q"), verbatim;
//   - net/http's Server logs a TLS handshake error with the client's address, and a recovered handler panic with its
//     VALUE and stack;
//   - httputil.ReverseProxy logs body-copy errors;
//   - the Go runtime prints a fatal panic's value and every goroutine's stack straight to fd 2.
// So every one of those paths is routed through consoleFilter. It passes a line that is the front's own `DOM …`
// statement and replaces anything else with ONE fixed, content-free line, "DOM front: <class>", where the class is
// chosen by the writer's first line and never carries a byte of it (only a byte count). enclave-d1's finding on
// release 79c5ecf2; enclave-87's fix spec.

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"log"
	"os"
	"regexp"
	"sync"
	"syscall"
)

type consoleFilter struct {
	mu  sync.Mutex
	out io.Writer
}

// the std logger's date/time prefix (log.LstdFlags, optionally with microseconds), kept on a line that passes
var logPrefix = regexp.MustCompile(`^\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}(\.\d+)? `)

// domLine reports whether one line (without its newline) is the front's own statement: `DOM ` at the start, after an
// optional std-logger timestamp.
func domLine(line []byte) bool {
	rest := line
	if m := logPrefix.Find(rest); m != nil {
		rest = rest[len(m):]
	}
	return bytes.HasPrefix(rest, []byte("DOM "))
}

// withheldClass names what was withheld, from its first line only, and never repeats a byte of it.
func withheldClass(first []byte, n int) string {
	rest := first
	if m := logPrefix.Find(rest); m != nil {
		rest = rest[len(m):]
	}
	switch {
	case bytes.Contains(rest, []byte("Unsolicited response received on idle HTTP channel")):
		return fmt.Sprintf("unsolicited upstream response (%d bytes withheld)", n)
	case bytes.HasPrefix(rest, []byte("http: TLS handshake error")):
		return "tls handshake error"
	case bytes.Contains(rest, []byte("panic")):
		return "panic (withheld)"
	default:
		return fmt.Sprintf("output withheld (%d bytes)", n)
	}
}

// filter turns ONE message into what the console may show: the message itself when it is exactly one `DOM` line (the
// front's own statements are all single-line), else ONE class line for the WHOLE message. It never judges line by line:
// a withheld message (a panic value, an error's %v) could otherwise carry "\nDOM …" and have that line pass as the
// front's (enclave-d1's review of 8be920fa).
func filter(p []byte) []byte {
	if len(p) == 0 {
		return nil
	}
	msg := bytes.TrimSuffix(p, []byte("\n"))
	if !bytes.Contains(msg, []byte("\n")) && domLine(msg) {
		return append(append([]byte{}, msg...), '\n')
	}
	first := msg
	if i := bytes.IndexByte(msg, '\n'); i >= 0 {
		first = msg[:i]
	}
	return []byte("DOM front: " + withheldClass(first, len(p)) + "\n")
}

// Write takes one message (the std logger makes one Write per message). It always reports the whole input written,
// so no writer ever retries a withheld line.
func (c *consoleFilter) Write(p []byte) (int, error) {
	c.emit(filter(p))
	return len(p), nil
}

func (c *consoleFilter) emit(b []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(b) > 0 {
		c.out.Write(b)
	}
}

// pump drains fd 2 (the Go runtime's crash output, any direct os.Stderr write). NOTHING on it passes: the front's own
// statements go to stdout or through the logger (which writes into the filter directly), never to fd 2, and fd-level
// writes are not message-aligned, so no line of them can be judged the front's. Each burst (the lines already
// buffered together) becomes ONE class line, chosen by its first line. A fatal crash may end the process before its
// lines are pumped; then nothing of it is shown, which is the point.
func (c *consoleFilter) pump(r io.Reader) {
	br := bufio.NewReaderSize(r, 64<<10)
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			first, n := bytes.TrimRight(line, "\n"), len(line)
			for err == nil && br.Buffered() > 0 {
				var more []byte
				more, err = br.ReadBytes('\n')
				n += len(more)
			}
			c.emit([]byte("DOM front: " + withheldClass(first, n) + "\n"))
		}
		if err != nil {
			return
		}
	}
}

// consoleLog is the logger every net/http and httputil logger is set to (srv.ErrorLog, the proxy's ErrorLog): the
// same filter, so a server error, a proxy error and a transport's own log line all pass through it.
var consoleLog *log.Logger

// guardConsole installs the filter, first thing in main, before anything can log:
//   - the std logger writes into it (net/http's Transport logs through the std logger, and so do the server and the
//     proxy when their ErrorLog is nil);
//   - fd 2 is replaced by a pipe the filter drains, so the runtime's own crash output passes through it too;
//   - the filter writes to a duplicate of the console fd 2 was.
//
// stdout (fd 1) is left as it is: only the front's own fmt.Printf("DOM …") statements write there, synchronously,
// so a `DOM ERROR front:` line just before exit is never lost in a pipe.
func guardConsole() error {
	cons, err := syscall.Dup(2)
	if err != nil {
		return fmt.Errorf("dup the console: %w", err)
	}
	f := &consoleFilter{out: os.NewFile(uintptr(cons), "console")}
	log.SetOutput(f)
	consoleLog = log.New(f, "", log.LstdFlags)
	r, w, err := os.Pipe()
	if err != nil {
		return fmt.Errorf("the console pipe: %w", err)
	}
	if err := syscall.Dup3(int(w.Fd()), 2, 0); err != nil {
		return fmt.Errorf("route fd 2 through the filter: %w", err)
	}
	w.Close()
	go f.pump(r)
	return nil
}
