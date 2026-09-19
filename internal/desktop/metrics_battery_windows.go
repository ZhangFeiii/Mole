//go:build windows

package desktop

import (
	"context"
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

type systemPowerStatus struct {
	ACLineStatus        byte
	BatteryFlag         byte
	BatteryLifePercent  byte
	Reserved            byte
	BatteryLifeTime     uint32
	BatteryFullLifeTime uint32
}

var (
	kernel32Power        = windows.NewLazySystemDLL("kernel32.dll")
	getSystemPowerStatus = kernel32Power.NewProc("GetSystemPowerStatus")
)

func collectBatteryMetric(ctx context.Context) (*BatteryMetric, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var status systemPowerStatus
	result, _, callErr := getSystemPowerStatus.Call(uintptr(unsafe.Pointer(&status)))
	if result == 0 {
		if callErr != windows.ERROR_SUCCESS {
			return nil, fmt.Errorf("GetSystemPowerStatus: %w", callErr)
		}
		return nil, fmt.Errorf("GetSystemPowerStatus failed")
	}
	// 255 means that no battery is present or that the reading is unknown.
	if status.BatteryLifePercent == 255 {
		return nil, errors.New("no battery detected; battery fields are null")
	}
	percent := float64(status.BatteryLifePercent)
	metric := &BatteryMetric{Percent: &percent}
	if status.ACLineStatus == 0 || status.ACLineStatus == 1 {
		charging := status.ACLineStatus == 1
		metric.Charging = &charging
	}
	if status.BatteryLifeTime != 0xffffffff {
		seconds := float64(status.BatteryLifeTime)
		metric.TimeRemainingSeconds = &seconds
	}
	source := "GetSystemPowerStatus"
	metric.Source = &source
	return metric, nil
}
