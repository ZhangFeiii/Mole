//go:build windows

package desktop

import (
	"errors"
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
)

func nativeAttributes(path string) (uint32, error) {
	if !localVolume(filepath.VolumeName(path) + string(os.PathSeparator)) {
		return 0, errors.New("only fixed or removable local volumes are supported")
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	return windows.GetFileAttributes(name)
}
