//go:build linux

package desktop

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

var drmCardPattern = regexp.MustCompile(`^card[0-9]+$`)

func collectGPUMetrics(ctx context.Context) ([]GPUMetric, error) {
	entries, err := os.ReadDir("/sys/class/drm")
	if err != nil {
		return []GPUMetric{}, fmt.Errorf("read DRM devices: %w", err)
	}
	result := make([]GPUMetric, 0, len(entries))
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		if !drmCardPattern.MatchString(entry.Name()) {
			continue
		}
		root := filepath.Join("/sys/class/drm", entry.Name(), "device")
		name := entry.Name()
		metric := GPUMetric{Name: &name}
		if value, err := readTrimmed(filepath.Join(root, "vendor")); err == nil && value != "" {
			metric.Vendor = &value
		}
		if value, err := readTrimmed(filepath.Join(root, "mem_info_vram_total")); err == nil {
			if bytes, parseErr := strconv.ParseUint(value, 10, 64); parseErr == nil {
				metric.MemoryBytes = &bytes
			}
		}
		if value, err := readTrimmed(filepath.Join(root, "gpu_busy_percent")); err == nil {
			if percent, parseErr := strconv.ParseFloat(value, 64); parseErr == nil && percent >= 0 && percent <= 100 {
				metric.UtilizationPercent = &percent
			}
		}
		source := "sysfs:" + root
		metric.Source = &source
		result = append(result, metric)
	}
	if len(result) == 0 {
		return result, errors.New("no DRM GPU information was available")
	}
	for _, item := range result {
		if item.MemoryBytes == nil || item.UtilizationPercent == nil {
			return result, errors.New("GPU memory or utilization is unavailable; unsupported fields are null")
		}
	}
	return result, nil
}

func readTrimmed(path string) (string, error) {
	value, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(value)), nil
}
