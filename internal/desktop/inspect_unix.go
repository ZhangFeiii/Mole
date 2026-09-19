//go:build darwin || linux

package desktop

import "errors"

func nativeAttributes(_ string) (uint32, error) {
	return 0, errors.New("Windows native attributes are unavailable on this platform")
}

func nativeInUse(_ string) (bool, error) {
	return false, errors.New("native Windows in-use state is unavailable")
}
