//go:build windows

package desktop

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func TestInspectionDetectsOpenDataHandle(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "busy.tmp")
	if err := os.WriteFile(file, []byte("fixture-only"), 0600); err != nil {
		t.Fatal(err)
	}
	name, err := windows.UTF16PtrFromString(file)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	first, err := InspectPaths([]string{file})
	if err != nil {
		windows.CloseHandle(handle)
		t.Fatal(err)
	}
	if first.Items[0].InUse == nil || !*first.Items[0].InUse {
		windows.CloseHandle(handle)
		t.Fatalf("active handle not detected: %+v", first.Items)
	}
	if err := windows.CloseHandle(handle); err != nil {
		t.Fatal(err)
	}
	second, err := InspectPaths([]string{file})
	if err != nil {
		t.Fatal(err)
	}
	if second.Items[0].Error != "" || second.Items[0].InUse == nil || *second.Items[0].InUse {
		t.Fatalf("closed file not confirmed idle: %+v", second.Items)
	}
	data, err := os.ReadFile(file)
	if err != nil || string(data) != "fixture-only" {
		t.Fatal("inspection changed fixture")
	}
}
