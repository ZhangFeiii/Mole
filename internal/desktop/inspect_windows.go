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
	return guardedAttributes(path, rawWindowsAttributes)
}

func rawWindowsAttributes(path string) (uint32, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	return windows.GetFileAttributes(name)
}

// An attributes-only, no-share handle detects existing data handles without
// reading file contents. OPEN_NO_RECALL and OPEN_REPARSE_POINT avoid hydration.
func nativeInUse(path string) (bool, error) {
	if err := inspectParents(path, rawWindowsAttributes); err != nil {
		return false, err
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return false, err
	}
	handle, err := windows.CreateFile(name, windows.FILE_READ_ATTRIBUTES, 0, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|0x00100000, 0)
	if errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	defer windows.CloseHandle(handle)
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return false, err
	}
	if info.FileAttributes&(0x400|0x1000|0x40000|0x400000|0x10) != 0 {
		return false, errors.New("object changed to protected type during inspection")
	}
	return false, nil
}
