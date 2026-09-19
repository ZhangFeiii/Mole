//go:build linux

package desktop

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func collectBatteryMetric(ctx context.Context) (*BatteryMetric, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir("/sys/class/power_supply")
	if err != nil {
		return nil, fmt.Errorf("read power supply: %w", err)
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		name := entry.Name()
		if !strings.HasPrefix(strings.ToUpper(name), "BAT") {
			continue
		}
		root := filepath.Join("/sys/class/power_supply", name)
		capacityText, err := os.ReadFile(filepath.Join(root, "capacity"))
		if err != nil {
			return nil, fmt.Errorf("read %s capacity: %w", name, err)
		}
		capacity, err := strconv.ParseFloat(strings.TrimSpace(string(capacityText)), 64)
		if err != nil || capacity < 0 || capacity > 100 {
			return nil, fmt.Errorf("invalid %s battery capacity", name)
		}
		statusText, statusErr := os.ReadFile(filepath.Join(root, "status"))
		status := strings.TrimSpace(string(statusText))
		if statusErr != nil {
			status = ""
		}
		metric := &BatteryMetric{Percent: &capacity}
		switch status {
		case "Charging", "Full":
			charging := true
			metric.Charging = &charging
		case "Discharging", "Not charging":
			charging := false
			metric.Charging = &charging
		}
		if remainingText, readErr := os.ReadFile(filepath.Join(root, "time_to_empty_now")); readErr == nil {
			if seconds, parseErr := strconv.ParseFloat(strings.TrimSpace(string(remainingText)), 64); parseErr == nil && seconds >= 0 {
				metric.TimeRemainingSeconds = &seconds
			}
		}
		source := "sysfs:" + root
		metric.Source = &source
		return metric, nil
	}
	return nil, errors.New("no battery detected; battery fields are null")
}
