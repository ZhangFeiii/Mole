//go:build darwin || linux

package desktop

import "errors"

func nativeAttributes(_ string) (uint32, error) {
	return 0, errors.New("Windows native attributes are unavailable on this platform")
}
