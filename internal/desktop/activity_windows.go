//go:build windows

package desktop

import (
	"errors"
	"golang.org/x/sys/windows"
	"sort"
	"strings"
	"unsafe"
)

func nativeActivity() ([]string, error) {
	handle, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(handle)
	entry := windows.ProcessEntry32{}
	entry.Size = uint32(unsafe.Sizeof(entry))
	if err = windows.Process32First(handle, &entry); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for count := 0; count < 65536; count++ {
		name := strings.ToLower(strings.TrimSpace(windows.UTF16ToString(entry.ExeFile[:])))
		if name == "" {
			return nil, errors.New("process snapshot contains an unnamed process")
		}
		seen[name] = true
		err = windows.Process32Next(handle, &entry)
		if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
			names := make([]string, 0, len(seen))
			for name := range seen {
				names = append(names, name)
			}
			sort.Strings(names)
			return names, nil
		}
		if err != nil {
			return nil, err
		}
	}
	return nil, errors.New("process snapshot exceeded safety bound")
}
