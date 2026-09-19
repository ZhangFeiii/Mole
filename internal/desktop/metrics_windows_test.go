//go:build windows

package desktop

import (
	"context"
	"testing"
	"time"
)

func TestWindowsReadOnlyHardwareMetrics(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	battery, batteryErr := collectBatteryMetric(ctx)
	if batteryErr != nil {
		t.Logf("battery unavailable: %v", batteryErr)
	}
	if battery != nil && (battery.Percent == nil || *battery.Percent < 0 || *battery.Percent > 100) {
		t.Fatal("Windows battery reading was outside 0..100")
	}
	gpu, gpuErr := collectGPUMetrics(ctx)
	if gpuErr != nil {
		t.Logf("GPU inventory unavailable: %v", gpuErr)
	}
	for _, item := range gpu {
		if item.Name == nil || *item.Name == "" {
			t.Fatal("Windows GPU inventory returned an unnamed adapter")
		}
	}
}
