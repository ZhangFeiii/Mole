package desktop

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// PathAttributes is metadata only. An inspection failure must never be treated
// by a caller as an ordinary local file with zero attributes.
type PathAttributes struct {
	Path       string  `json:"path"`
	Attributes *uint32 `json:"attributes"`
	InUse      *bool   `json:"inUse"`
	Error      string  `json:"error,omitempty"`
	Code       string  `json:"code,omitempty"`
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
			if os.IsNotExist(err) {
				item.Code = "notFound"
			} else {
				item.Code = "unavailable"
			}
		} else {
			item.Attributes = &attributes
			if attributes&0x10 != 0 {
				idle := false
				item.InUse = &idle
			} else if attributes&(0x400|0x1000|0x40000|0x400000) == 0 {
				busy, probeErr := nativeInUse(path)
				if probeErr != nil {
					item.Error = probeErr.Error()
				} else {
					item.InUse = &busy
				}
			}
		}
		result.Items = append(result.Items, item)
	}
	return result, nil
}

// Parent components are probed in order before a descendant is queried. This
// prevents even read-only preview from entering a junction/cloud subtree.
func inspectParents(path string, read func(string) (uint32, error)) error {
	parents := []string{}
	for p := filepath.Dir(filepath.Clean(path)); ; p = filepath.Dir(p) {
		parents = append(parents, p)
		if filepath.Dir(p) == p {
			break
		}
	}
	for i := len(parents) - 1; i >= 0; i-- {
		attrs, err := read(parents[i])
		if err != nil {
			return err
		}
		if attrs&0x10 == 0 || attrs&(0x400|0x1000|0x40000|0x400000) != 0 {
			return fmt.Errorf("protected ancestor: %s", parents[i])
		}
	}
	return nil
}

func guardedAttributes(path string, read func(string) (uint32, error)) (uint32, error) {
	if err := inspectParents(path, read); err != nil {
		return 0, err
	}
	return read(filepath.Clean(path))
}
