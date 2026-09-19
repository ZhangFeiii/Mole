// Mole Desktop's child process exposes read-only commands only. It never
// invokes PowerShell, a shell, or the upstream cleanup/uninstall executables.
package main

import (
	"bytes"
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
	var err error
	if len(os.Args) == 2 && os.Args[1] == "inspect" {
		err = runInspect(os.Stdin, os.Stdout)
	} else {
		err = run(os.Args[1:], os.Stdout)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// Inspect requests are data on stdin, not interpolated shell arguments.
func runInspect(in io.Reader, out io.Writer) error {
	var request struct {
		Paths []string `json:"paths"`
	}
	payload, err := io.ReadAll(io.LimitReader(in, 2*1024*1024+1))
	if err != nil {
		return err
	}
	if len(payload) > 2*1024*1024 {
		return fmt.Errorf("inspection request exceeds 2 MiB")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return fmt.Errorf("unexpected trailing input")
	}
	result, err := desktop.InspectPaths(request.Paths)
	if err != nil {
		return err
	}
	return json.NewEncoder(out).Encode(result)
}
