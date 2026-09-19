//go:build !darwin

package desktop

import (
	"context"
	"errors"
)

func collectDarwinDiskIOMetrics(_ context.Context) ([]DiskIOMetric, error) {
	return nil, errors.New("Darwin disk I/O fallback is unavailable")
}
