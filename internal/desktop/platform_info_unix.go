//go:build darwin || linux

package desktop

func nativeSystemDirectory() (string, error) { return "", nil }
