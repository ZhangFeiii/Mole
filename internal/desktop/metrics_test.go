package desktop

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestMetricsIncludesBoundedOptionalReadings(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	metrics := Collect(ctx)
	if metrics.Processes.TopCPU == nil || metrics.Processes.TopMemory == nil {
		t.Fatal("process metrics must be JSON arrays")
	}
	if len(metrics.Processes.TopCPU) > topProcessCount || len(metrics.Processes.TopMemory) > topProcessCount {
		t.Fatal("process top lists exceeded their bound")
	}
	if metrics.DiskIO == nil || metrics.GPU == nil || metrics.Warnings == nil {
		t.Fatal("optional metric collections must be JSON arrays")
	}
	if metrics.Battery != nil {
		if metrics.Battery.Percent == nil || *metrics.Battery.Percent < 0 || *metrics.Battery.Percent > 100 {
			t.Fatal("battery percentage was not a bounded reading")
		}
	}
	for _, item := range metrics.DiskIO {
		if item.ReadBytes == nil || item.WriteBytes == nil {
			continue
		}
		if item.ReadBytesPerSecond != nil && *item.ReadBytesPerSecond < 0 {
			t.Fatal("disk read rate cannot be negative")
		}
		if item.WriteBytesPerSecond != nil && *item.WriteBytesPerSecond < 0 {
			t.Fatal("disk write rate cannot be negative")
		}
	}
	encoded, err := json.Marshal(metrics)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"processes", "diskIO", "battery", "gpu", "warnings"} {
		if _, ok := decoded[key]; !ok {
			t.Fatalf("metrics JSON omitted %s", key)
		}
	}
}

func TestMetricsNeverUsesZeroAsUnavailableOptionalValue(t *testing.T) {
	metrics := Metrics{
		Processes: ProcessMetrics{TopCPU: []ProcessMetric{}, TopMemory: []ProcessMetric{}},
		DiskIO:    []DiskIOMetric{},
		GPU:       []GPUMetric{},
		Warnings:  []string{"battery unavailable"},
	}
	encoded, err := json.Marshal(metrics)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["battery"] != nil {
		t.Fatalf("unavailable battery must be null, got %v", decoded["battery"])
	}
}
