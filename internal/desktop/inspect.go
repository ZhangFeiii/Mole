package desktop

import (
	"errors"
	"path/filepath"
	"runtime"
	"strings"
)

// PathAttributes is metadata only. An inspection failure must never be treated
// by a caller as an ordinary local file with zero attributes.
type PathAttributes struct {
	Path       string  `json:"path"`
	Attributes *uint32 `json:"attributes"`
	Error      string  `json:"error,omitempty"`
}

type Inspection struct {
	Platform string           `json:"platform"`
	Items    []PathAttributes `json:"items"`
}

func InspectPaths(paths []string) (Inspection, error) {
	result := Inspection{Platform: runtime.GOOS, Items: []PathAttributes{}}
	if len(paths) == 0 || len(paths) > 2048 {
		return result, errors.New("inspection requires 1 to 2048 paths")
	}
	for _, path := range paths {
		item := PathAttributes{Path: path}
		if !filepath.IsAbs(path) || len(path) > 32767 || strings.ContainsRune(path, 0) || strings.HasPrefix(path, `\\`) || strings.HasPrefix(path, "//") {
			item.Error = "not a supported absolute local path"
		} else if attributes, err := nativeAttributes(path); err != nil {
			item.Error = err.Error()
		} else {
			item.Attributes = &attributes
		}
		result.Items = append(result.Items, item)
	}
	return result, nil
}
