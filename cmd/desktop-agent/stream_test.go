package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tw93/mole/windows/internal/desktop"
)

type errorWriter struct{ calls int }

func (w *errorWriter) Write(p []byte) (int, error) {
	w.calls++
	if w.calls == 3 {
		return 0, io.ErrClosedPipe
	}
	return len(p), nil
}

func TestStatusStreamStopsOnBrokenOutput(t *testing.T) {
	writer := &errorWriter{}
	err := streamSnapshots(context.Background(), writer, time.Millisecond, time.Second, func(context.Context) desktop.Metrics { return desktop.Metrics{CollectedAt: 123} })
	if !errors.Is(err, io.ErrClosedPipe) || writer.calls != 3 {
		t.Fatalf("%v calls=%d", err, writer.calls)
	}
}

func TestStatusStreamSerialSamplesAndCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var active, max, calls atomic.Int32
	var out bytes.Buffer
	err := streamSnapshots(ctx, &out, time.Millisecond, time.Second, func(sample context.Context) desktop.Metrics {
		n := active.Add(1)
		if n > max.Load() {
			max.Store(n)
		}
		defer active.Add(-1)
		if _, ok := sample.Deadline(); !ok {
			t.Error("sample context needs a deadline")
		}
		count := calls.Add(1)
		time.Sleep(3 * time.Millisecond)
		if count == 4 {
			cancel()
		}
		return desktop.Metrics{CollectedAt: int64(count)}
	})
	if err != nil || max.Load() != 1 {
		t.Fatalf("err=%v max concurrency=%d", err, max.Load())
	}
	decoder := json.NewDecoder(&out)
	var frames int
	for {
		var m desktop.Metrics
		err := decoder.Decode(&m)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		frames++
		if m.CollectedAt != int64(frames) {
			t.Fatalf("bad frame %+v", m)
		}
	}
	if frames != 3 {
		t.Fatalf("expected three complete JSON lines, got %d", frames)
	}
}

func TestStatusStreamPropagatesTimeoutWithoutOverlapping(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var called int
	err := streamSnapshots(ctx, &bytes.Buffer{}, time.Millisecond, 2*time.Millisecond, func(sample context.Context) desktop.Metrics {
		called++
		<-sample.Done()
		if !errors.Is(sample.Err(), context.DeadlineExceeded) {
			t.Error("missing sample deadline")
		}
		cancel()
		return desktop.Metrics{}
	})
	if err != nil || called != 1 {
		t.Fatalf("err=%v called=%d", err, called)
	}
}
