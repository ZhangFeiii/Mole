//go:build darwin

package desktop

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var darwinBatteryCache struct {
	sync.Mutex
	at      time.Time
	value   *BatteryMetric
	warning error
}

var (
	darwinBatteryPercentPattern = regexp.MustCompile(`([0-9]+(?:\.[0-9]+)?)%`)
	darwinBatteryTimePattern    = regexp.MustCompile(`([0-9]{1,3}):([0-9]{2})\s+remaining`)
)

func collectBatteryMetric(ctx context.Context) (*BatteryMetric, error) {
	darwinBatteryCache.Lock()
	if time.Since(darwinBatteryCache.at) < 10*time.Second {
		value := cloneBatteryMetric(darwinBatteryCache.value)
		warning := darwinBatteryCache.warning
		darwinBatteryCache.Unlock()
		return value, warning
	}
	darwinBatteryCache.Unlock()

	queryCtx, cancel := context.WithTimeout(ctx, 700*time.Millisecond)
	defer cancel()
	output, err := exec.CommandContext(queryCtx, "/usr/bin/pmset", "-g", "batt").Output()
	if err != nil {
		return nil, fmt.Errorf("pmset battery query: %w", err)
	}
	value, err := parseDarwinBattery(string(output))
	darwinBatteryCache.Lock()
	darwinBatteryCache.at = time.Now()
	darwinBatteryCache.value = cloneBatteryMetric(value)
	darwinBatteryCache.warning = err
	darwinBatteryCache.Unlock()
	return value, err
}

func parseDarwinBattery(output string) (*BatteryMetric, error) {
	percentMatch := darwinBatteryPercentPattern.FindStringSubmatch(output)
	if len(percentMatch) != 2 {
		// Desktop Macs and Macs with an unavailable battery legitimately return
		// no battery row. This is not a zero-percent reading.
		return nil, errors.New("no battery detected; battery fields are null")
	}
	percent, err := strconv.ParseFloat(percentMatch[1], 64)
	if err != nil || percent < 0 || percent > 100 {
		return nil, fmt.Errorf("invalid macOS battery percentage")
	}
	charging := strings.Contains(strings.ToLower(output), "charging") && !strings.Contains(strings.ToLower(output), "discharging")
	metric := &BatteryMetric{Percent: &percent}
	metric.Charging = &charging
	if timeMatch := darwinBatteryTimePattern.FindStringSubmatch(output); len(timeMatch) == 3 {
		hours, hourErr := strconv.ParseFloat(timeMatch[1], 64)
		minutes, minuteErr := strconv.ParseFloat(timeMatch[2], 64)
		if hourErr == nil && minuteErr == nil {
			seconds := hours*3600 + minutes*60
			metric.TimeRemainingSeconds = &seconds
		}
	}
	source := "pmset -g batt"
	metric.Source = &source
	return metric, nil
}

func cloneBatteryMetric(value *BatteryMetric) *BatteryMetric {
	if value == nil {
		return nil
	}
	clone := *value
	if value.Percent != nil {
		percent := *value.Percent
		clone.Percent = &percent
	}
	if value.Charging != nil {
		charging := *value.Charging
		clone.Charging = &charging
	}
	if value.TimeRemainingSeconds != nil {
		seconds := *value.TimeRemainingSeconds
		clone.TimeRemainingSeconds = &seconds
	}
	if value.Source != nil {
		source := *value.Source
		clone.Source = &source
	}
	return &clone
}
