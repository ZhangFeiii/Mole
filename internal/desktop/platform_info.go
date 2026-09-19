package desktop

import "runtime"

type PlatformInfo struct {
	Platform        string `json:"platform"`
	Schema          int    `json:"schema"`
	SystemDirectory string `json:"systemDirectory"`
}

func ReadPlatformInfo() (PlatformInfo, error) {
	directory, err := nativeSystemDirectory()
	return PlatformInfo{Platform: runtime.GOOS, Schema: 1, SystemDirectory: directory}, err
}
