//go:build darwin || linux

package desktop

import (
	"os"
	"syscall"
)

func skipReason(_ string, info os.FileInfo) string {
	if info.Mode()&os.ModeSymlink != 0 {
		return "link"
	}
	return ""
}

func sameVolume(root, info os.FileInfo) bool {
	a, okA := root.Sys().(*syscall.Stat_t)
	b, okB := info.Sys().(*syscall.Stat_t)
	return !okA || !okB || a.Dev == b.Dev
}

func localVolume(_ string) bool { return true }
