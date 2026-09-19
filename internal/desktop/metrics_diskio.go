package desktop

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/disk"
)

type diskIOSample struct {
	at         time.Time
	readBytes  uint64
	writeBytes uint64
	readCount  uint64
	writeCount uint64
}

var diskIOHistory = struct {
	sync.Mutex
	values map[string]diskIOSample
}{values: make(map[string]diskIOSample)}

// collectDiskIOMetrics returns cumulative counters and rates only when a
// previous counter sample is available. A counter reset or a missing first
// sample is represented by null rates, never by fabricated zeroes.
func collectDiskIOMetrics(ctx context.Context) ([]DiskIOMetric, error) {
	counters, err := disk.IOCountersWithContext(ctx)
	if err != nil || len(counters) == 0 {
		if darwinCounters, darwinErr := collectDarwinDiskIOMetrics(ctx); darwinErr == nil {
			return darwinCounters, nil
		}
		if err != nil {
			return []DiskIOMetric{}, err
		}
		return []DiskIOMetric{}, fmt.Errorf("no readable disk I/O counters")
	}
	now := time.Now()
	result := make([]DiskIOMetric, 0, len(counters))
	diskIOHistory.Lock()
	defer diskIOHistory.Unlock()
	for name, counter := range counters {
		if name == "" {
			continue
		}
		nameCopy := name
		readBytes := counter.ReadBytes
		writeBytes := counter.WriteBytes
		readCount := counter.ReadCount
		writeCount := counter.WriteCount
		metric := DiskIOMetric{
			Name:       &nameCopy,
			ReadBytes:  &readBytes,
			WriteBytes: &writeBytes,
			ReadCount:  &readCount,
			WriteCount: &writeCount,
		}
		if previous, ok := diskIOHistory.values[name]; ok {
			seconds := now.Sub(previous.at).Seconds()
			if seconds > 0 && seconds <= 120 && readBytes >= previous.readBytes && writeBytes >= previous.writeBytes && readCount >= previous.readCount && writeCount >= previous.writeCount {
				readRate := float64(readBytes-previous.readBytes) / seconds
				writeRate := float64(writeBytes-previous.writeBytes) / seconds
				readCountRate := float64(readCount-previous.readCount) / seconds
				writeCountRate := float64(writeCount-previous.writeCount) / seconds
				metric.ReadBytesPerSecond = &readRate
				metric.WriteBytesPerSecond = &writeRate
				metric.ReadCountPerSecond = &readCountRate
				metric.WriteCountPerSecond = &writeCountRate
			}
		}
		diskIOHistory.values[name] = diskIOSample{
			at:         now,
			readBytes:  readBytes,
			writeBytes: writeBytes,
			readCount:  readCount,
			writeCount: writeCount,
		}
		result = append(result, metric)
	}
	if len(result) == 0 {
		return result, fmt.Errorf("no readable disk I/O counters")
	}
	return result, nil
}
