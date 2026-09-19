//go:build windows

package desktop

import "golang.org/x/sys/windows"

func nativeSystemDirectory() (string, error) { return windows.GetSystemDirectory() }
