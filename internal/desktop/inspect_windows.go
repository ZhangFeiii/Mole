//go:build windows

package desktop

import (
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
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

// Metadata-only access is exempt from Windows share-mode checks. Request
// GENERIC_READ so a no-share open participates in data sharing, but never call
// ReadFile: the handle is used only for identity/attribute queries and closed.
// Reject unsafe ancestors and target attributes before requesting the handle;
// OPEN_NO_RECALL and OPEN_REPARSE_POINT remain defense in depth.
func nativeInUse(path string) (bool, error) {
	attributes, err := nativeAttributes(path)
	if err != nil {
		return false, err
	}
	if attributes&(0x400|0x1000|0x40000|0x400000|0x10) != 0 {
		return false, errors.New("protected target cannot be probed for data sharing")
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return false, err
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_READ, 0, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_OPEN_NO_RECALL, 0)
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
