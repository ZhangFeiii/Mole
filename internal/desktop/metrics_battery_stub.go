//go:build !windows && !darwin && !linux

package desktop

import (
	"context"
	"errors"
)

func collectBatteryMetric(_ context.Context) (*BatteryMetric, error) {
	return nil, errors.New("battery information is unavailable on this platform")
}
