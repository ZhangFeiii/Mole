//go:build windows

package desktop

import (
	"os"
	"syscall"

	"golang.org/x/sys/windows"
)

func skipReason(_ string, info os.FileInfo) string {
	if info.Mode()&os.ModeSymlink != 0 {
		return "link"
	}
	if data, ok := info.Sys().(*syscall.Win32FileAttributeData); ok {
		// Reparse points include junctions and cloud placeholders. Do not traverse
		// even pinned placeholders: conservative metadata-only behaviour is explicit.
		if data.FileAttributes&(0x1000|0x40000|0x400000) != 0 {
			return "cloud"
		}
		if data.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return "link"
		}
	}
	return ""
}

func sameVolume(_, _ os.FileInfo) bool { return true }

func localVolume(path string) bool {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return false
	}
	kind := windows.GetDriveType(p)
	return kind == windows.DRIVE_FIXED || kind == windows.DRIVE_REMOVABLE
}
