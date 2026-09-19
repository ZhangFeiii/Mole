package main

import (
	"context"
	"encoding/json"
	"io"
	"time"

	"github.com/tw93/mole/windows/internal/desktop"
)

// The command exposes no configurable interval or write action. Keeping one
// process preserves the collectors' preceding counters and process caches.
func runStatusStream(ctx context.Context, out io.Writer) error {
	return streamSnapshots(ctx, out, 2*time.Second, 8*time.Second, desktop.Collect)
}

// Collect is synchronous: missed ticks are coalesced, never overlapping work.
func streamSnapshots(ctx context.Context, out io.Writer, interval, timeout time.Duration, collect func(context.Context) desktop.Metrics) error {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	encoder := json.NewEncoder(out)
	for {
		if ctx.Err() != nil {
			return nil
		}
		sampleCtx, cancel := context.WithTimeout(ctx, timeout)
		metrics := collect(sampleCtx)
		cancel()
		if ctx.Err() != nil {
			return nil
		}
		if err := encoder.Encode(metrics); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}
