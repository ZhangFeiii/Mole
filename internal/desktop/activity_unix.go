//go:build darwin || linux

package desktop

import "errors"

func nativeActivity() ([]string, error) {
	return nil, errors.New("Windows process activity is unavailable on this platform")
}
