//go:build darwin

package desktop

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var darwinGPUCache struct {
	sync.Mutex
	at      time.Time
	values  []GPUMetric
	warning error
}

var gpuMemoryPattern = regexp.MustCompile(`(?i)^\s*([0-9]+(?:\.[0-9]+)?)\s*(KB|MB|GB)`)

func collectGPUMetrics(ctx context.Context) ([]GPUMetric, error) {
	darwinGPUCache.Lock()
	if time.Since(darwinGPUCache.at) < 30*time.Second {
		values := cloneGPUMetrics(darwinGPUCache.values)
		warning := darwinGPUCache.warning
		darwinGPUCache.Unlock()
		return values, warning
	}
	darwinGPUCache.Unlock()

	queryCtx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
	defer cancel()
	output, err := exec.CommandContext(
		queryCtx,
		"/usr/sbin/system_profiler",
		"SPDisplaysDataType",
		"-json",
	).Output()
	if err != nil {
		return []GPUMetric{}, fmt.Errorf("system_profiler GPU query: %w", err)
	}
	var document map[string]any
	if err := json.Unmarshal(output, &document); err != nil {
		return []GPUMetric{}, fmt.Errorf("parse system_profiler GPU response: %w", err)
	}
	values := make([]GPUMetric, 0, 4)
	collectDarwinGPUObjects(document, &values, 0)
	if len(values) == 0 {
		return []GPUMetric{}, fmt.Errorf("system_profiler returned no GPU information")
	}
	var warning error
	darwinGPUCache.Lock()
	darwinGPUCache.at = time.Now()
	darwinGPUCache.values = cloneGPUMetrics(values)
	for _, item := range values {
		if item.UtilizationPercent == nil {
			warning = fmt.Errorf("GPU utilization is unavailable from read-only system_profiler; unsupported fields are null")
			break
		}
	}
	darwinGPUCache.warning = warning
	darwinGPUCache.Unlock()
	return values, warning
}

func collectDarwinGPUObjects(value any, result *[]GPUMetric, depth int) {
	if depth > 5 || len(*result) >= 8 {
		return
	}
	switch typed := value.(type) {
	case []any:
		for _, item := range typed {
			collectDarwinGPUObjects(item, result, depth+1)
		}
	case map[string]any:
		name := stringValue(typed["_name"])
		if name != "" && hasDisplayProperty(typed) {
			metric := GPUMetric{Name: &name}
			if vendor := normalizeGPUVendor(stringValue(typed["spdisplays_vendor"])); vendor != "" {
				metric.Vendor = &vendor
			}
			if memory := parseGPUMemory(stringValue(typed["spdisplays_vram"])); memory != nil {
				metric.MemoryBytes = memory
			}
			source := "system_profiler SPDisplaysDataType"
			metric.Source = &source
			*result = append(*result, metric)
		}
		for _, child := range typed {
			collectDarwinGPUObjects(child, result, depth+1)
		}
	}
}

func hasDisplayProperty(value map[string]any) bool {
	for key := range value {
		switch key {
		case "spdisplays_vendor", "spdisplays_vram", "spdisplays_device-id", "spdisplays_renderer", "spdisplays_gmux-version":
			return true
		}
	}
	return false
}

func stringValue(value any) string {
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text)
	}
	return ""
}

func normalizeGPUVendor(value string) string {
	if index := strings.Index(value, "("); index >= 0 {
		value = strings.TrimSpace(value[:index])
	}
	return value
}

func parseGPUMemory(value string) *uint64 {
	match := gpuMemoryPattern.FindStringSubmatch(value)
	if len(match) != 3 {
		return nil
	}
	amount, err := strconv.ParseFloat(match[1], 64)
	if err != nil || amount < 0 {
		return nil
	}
	multiplier := float64(1024 * 1024)
	switch strings.ToUpper(match[2]) {
	case "KB":
		multiplier = 1024
	case "GB":
		multiplier = 1024 * 1024 * 1024
	}
	bytes := uint64(amount * multiplier)
	return &bytes
}

func cloneGPUMetrics(values []GPUMetric) []GPUMetric {
	result := make([]GPUMetric, 0, len(values))
	for _, value := range values {
		clone := value
		if value.Name != nil {
			name := *value.Name
			clone.Name = &name
		}
		if value.Vendor != nil {
			vendor := *value.Vendor
			clone.Vendor = &vendor
		}
		if value.MemoryBytes != nil {
			memory := *value.MemoryBytes
			clone.MemoryBytes = &memory
		}
		if value.Source != nil {
			source := *value.Source
			clone.Source = &source
		}
		if value.UtilizationPercent != nil {
			utilization := *value.UtilizationPercent
			clone.UtilizationPercent = &utilization
		}
		result = append(result, clone)
	}
	return result
}
