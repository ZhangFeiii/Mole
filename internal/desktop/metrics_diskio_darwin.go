//go:build darwin

package desktop

import (
	"context"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var darwinDiskIOCache struct {
	sync.Mutex
	at     time.Time
	values []DiskIOMetric
}

var (
	darwinBSDNamePattern    = regexp.MustCompile(`"BSD Name"\s*=\s*"([^"]+)"`)
	darwinReadBytesPattern  = regexp.MustCompile(`"Bytes \(Read\)"\s*=\s*([0-9]+)`)
	darwinWriteBytesPattern = regexp.MustCompile(`"Bytes \(Write\)"\s*=\s*([0-9]+)`)
	darwinReadCountPattern  = regexp.MustCompile(`"Operations \(Read\)"\s*=\s*([0-9]+)`)
	darwinWriteCountPattern = regexp.MustCompile(`"Operations \(Write\)"\s*=\s*([0-9]+)`)
)

type darwinDiskCounter struct {
	name       string
	readBytes  uint64
	writeBytes uint64
	readCount  uint64
	writeCount uint64
}

func collectDarwinDiskIOMetrics(ctx context.Context) ([]DiskIOMetric, error) {
	darwinDiskIOCache.Lock()
	if time.Since(darwinDiskIOCache.at) < 5*time.Second {
		cached := cloneDiskIOMetrics(darwinDiskIOCache.values)
		darwinDiskIOCache.Unlock()
		return cached, nil
	}
	darwinDiskIOCache.Unlock()

	queryCtx, cancel := context.WithTimeout(ctx, 1200*time.Millisecond)
	defer cancel()
	output, err := exec.CommandContext(
		queryCtx,
		"/usr/sbin/ioreg",
		"-c",
		"IOBlockStorageDriver",
		"-r",
		"-l",
		"-w",
		"0",
	).Output()
	if err != nil {
		return []DiskIOMetric{}, fmt.Errorf("ioreg: %w", err)
	}
	counters := parseDarwinDiskCounters(string(output))
	if len(counters) == 0 {
		return []DiskIOMetric{}, fmt.Errorf("ioreg returned no disk I/O counters")
	}
	values := make([]DiskIOMetric, 0, len(counters))
	for _, counter := range counters {
		name := counter.name
		readBytes := counter.readBytes
		writeBytes := counter.writeBytes
		readCount := counter.readCount
		writeCount := counter.writeCount
		values = append(values, DiskIOMetric{
			Name:       &name,
			ReadBytes:  &readBytes,
			WriteBytes: &writeBytes,
			ReadCount:  &readCount,
			WriteCount: &writeCount,
		})
	}
	darwinDiskIOCache.Lock()
	darwinDiskIOCache.at = time.Now()
	darwinDiskIOCache.values = cloneDiskIOMetrics(values)
	darwinDiskIOCache.Unlock()
	return values, nil
}

func parseDarwinDiskCounters(output string) []darwinDiskCounter {
	var counters []darwinDiskCounter
	var current *darwinDiskCounter
	flush := func() {
		if current != nil && current.name != "" {
			counters = append(counters, *current)
		}
	}
	for _, line := range strings.Split(output, "\n") {
		if match := darwinBSDNamePattern.FindStringSubmatch(line); len(match) == 2 {
			flush()
			current = &darwinDiskCounter{name: match[1]}
			continue
		}
		if current == nil {
			continue
		}
		patterns := []struct {
			pattern *regexp.Regexp
			target  *uint64
		}{
			{darwinReadBytesPattern, &current.readBytes},
			{darwinWriteBytesPattern, &current.writeBytes},
			{darwinReadCountPattern, &current.readCount},
			{darwinWriteCountPattern, &current.writeCount},
		}
		for _, item := range patterns {
			if match := item.pattern.FindStringSubmatch(line); len(match) == 2 {
				value, err := strconv.ParseUint(match[1], 10, 64)
				if err == nil {
					*item.target = value
				}
				break
			}
		}
	}
	flush()
	return counters
}

func cloneDiskIOMetrics(values []DiskIOMetric) []DiskIOMetric {
	result := make([]DiskIOMetric, 0, len(values))
	for _, value := range values {
		clone := value
		if value.Name != nil {
			name := *value.Name
			clone.Name = &name
		}
		result = append(result, clone)
	}
	return result
}
