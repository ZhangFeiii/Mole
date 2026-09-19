// Mole Desktop's child process has exactly two read-only commands. It never
// invokes PowerShell, a shell, or the upstream cleanup/uninstall executables.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"time"

	"github.com/tw93/mole/windows/internal/desktop"
)

func run(args []string, out io.Writer) error {
	encoder := json.NewEncoder(out)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	if len(args) == 1 && args[0] == "status" {
		ctx, timeout := context.WithTimeout(ctx, 8*time.Second)
		defer timeout()
		return encoder.Encode(desktop.Collect(ctx))
	}
	if len(args) == 2 && args[0] == "scan" {
		ctx, timeout := context.WithTimeout(ctx, 30*time.Minute)
		defer timeout()
		var writeErr error
		result, err := desktop.Scan(ctx, args[1], desktop.ScanOptions{Progress: func(p desktop.ScanResult) {
			if writeErr == nil {
				writeErr = encoder.Encode(map[string]any{"type": "progress", "data": p})
			}
			if writeErr != nil {
				cancel()
			}
		}})
		if err != nil {
			return err
		}
		if writeErr != nil {
			return writeErr
		}
		return encoder.Encode(map[string]any{"type": "result", "data": result})
	}
	return fmt.Errorf("usage: desktop-agent status | desktop-agent scan ABSOLUTE_DIRECTORY")
}

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
