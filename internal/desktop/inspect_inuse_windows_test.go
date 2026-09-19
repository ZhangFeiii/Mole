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

func TestInspectionDetectsExistingReadWriteAndDeleteAccess(t *testing.T) {
	for _, tc := range []struct {
		name   string
		access uint32
	}{
		{"read-share-all", windows.GENERIC_READ},
		{"write-share-all", windows.GENERIC_WRITE},
		{"delete-share-all", windows.DELETE},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			file := filepath.Join(root, "held.tmp")
			if err := os.WriteFile(file, []byte("unchanged-fixture"), 0600); err != nil {
				t.Fatal(err)
			}
			name, err := windows.UTF16PtrFromString(file)
			if err != nil {
				t.Fatal(err)
			}
			handle, err := windows.CreateFile(name, tc.access, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
			if err != nil {
				t.Fatal(err)
			}
			// Even when the existing handle permits every sharing mode, the new
			// probe's no-share request must conflict with its granted data access.
			result, err := InspectPaths([]string{file})
			closeErr := windows.CloseHandle(handle)
			if closeErr != nil {
				t.Fatal(closeErr)
			}
			if err != nil {
				t.Fatal(err)
			}
			if result.Items[0].Error != "" || result.Items[0].InUse == nil || !*result.Items[0].InUse {
				t.Fatalf("held data access not detected: %+v", result.Items[0])
			}
			after, err := InspectPaths([]string{file})
			if err != nil {
				t.Fatal(err)
			}
			if after.Items[0].Error != "" || after.Items[0].InUse == nil || *after.Items[0].InUse {
				t.Fatalf("released object not confirmed: %+v", after.Items[0])
			}
			data, err := os.ReadFile(file)
			if err != nil || string(data) != "unchanged-fixture" {
				t.Fatal("probe changed fixture")
			}
		})
	}
}

func TestInUseProbeRejectsDirectoryBeforeDataOpen(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := nativeInUse(root); err == nil {
		t.Fatal("directory must not be opened as a data-sharing probe")
	}
}
