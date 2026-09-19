//go:build windows

package desktop

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

const displayDeviceMirroringDriver = 0x00000008

type displayDevice struct {
	cb           uint32
	deviceName   [32]uint16
	deviceString [128]uint16
	stateFlags   uint32
	deviceID     [128]uint16
	deviceKey    [128]uint16
}

var (
	user32GPU          = windows.NewLazySystemDLL("user32.dll")
	enumDisplayDevices = user32GPU.NewProc("EnumDisplayDevicesW")
	gpuVendorPattern   = regexp.MustCompile(`(?i)VEN_([0-9A-F]{4})`)
)

func collectGPUMetrics(ctx context.Context) ([]GPUMetric, error) {
	result := make([]GPUMetric, 0, 4)
	for index := uint32(0); index < 64; index++ {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		var device displayDevice
		device.cb = uint32(unsafe.Sizeof(device))
		ok, _, _ := enumDisplayDevices.Call(
			0,
			uintptr(index),
			uintptr(unsafe.Pointer(&device)),
			0,
		)
		if ok == 0 {
			break
		}
		if device.stateFlags&displayDeviceMirroringDriver != 0 {
			continue
		}
		name := utf16Value(device.deviceString[:])
		if name == "" {
			continue
		}
		metric := GPUMetric{Name: &name}
		deviceID := utf16Value(device.deviceID[:])
		if match := gpuVendorPattern.FindStringSubmatch(deviceID); len(match) == 2 {
			vendor := strings.ToUpper(match[1])
			metric.Vendor = &vendor
		}
		source := "EnumDisplayDevicesW"
		metric.Source = &source
		result = append(result, metric)
	}
	if len(result) == 0 {
		return result, errors.New("no display adapter information was available")
	}
	return result, errors.New("GPU memory and utilization are unavailable from the read-only display API; unsupported fields are null")
}

func utf16Value(value []uint16) string {
	decoded := strings.TrimRight(string(utf16.Decode(value)), "\x00")
	return strings.TrimSpace(decoded)
}
