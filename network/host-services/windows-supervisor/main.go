package main

import (
	"fmt"
	"log"
	"os"
)

// hostsvc-supervisor run <supervisor.json>    run the runner under the job until a clean exit, a stop or the start limit
// hostsvc-supervisor check <supervisor.json>  validate the configuration only
// hostsvc-supervisor stop <supervisor.json>   set the configured stop event (an administrator's graceful stop)
func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: hostsvc-supervisor run|check|stop <supervisor.json>")
		os.Exit(2)
	}
	c, err := LoadConfig(os.Args[2])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	switch os.Args[1] {
	case "check":
		fmt.Println("ok")
	case "stop":
		if err := signalStop(c.StopEvent); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("stop requested")
	case "run":
		f, err := os.OpenFile(c.Log, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o640)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		lg := log.New(f, "", log.LstdFlags|log.LUTC)
		stop, err := stopChannel(c.StopEvent)
		if err != nil {
			lg.Printf("stop event: %v", err)
			os.Exit(1)
		}
		os.Exit(Supervise(c, newLauncher(lg), stop, realClock{}, lg.Printf))
	default:
		fmt.Fprintln(os.Stderr, "usage: hostsvc-supervisor run|check|stop <supervisor.json>")
		os.Exit(2)
	}
}
