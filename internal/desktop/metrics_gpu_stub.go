//go:build !windows && !darwin && !linux

package desktop

import (
	"context"
	"errors"
)

func collectGPUMetrics(_ context.Context) ([]GPUMetric, error) {
	return []GPUMetric{}, errors.New("GPU inventory is unavailable on this platform")
}
