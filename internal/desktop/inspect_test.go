package desktop

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestInspectionFailsClosed(t *testing.T) {
	if _, err := InspectPaths(nil); err == nil {
		t.Fatal("accepted empty inspection")
	}
	if _, err := InspectPaths(make([]string, 2049)); err == nil {
		t.Fatal("accepted oversized inspection")
	}
	r, err := InspectPaths([]string{"relative", `\\server\share`, "/nul\x00path"})
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range r.Items {
		if item.Error == "" || item.Attributes != nil {
			t.Fatalf("invalid path accepted: %+v", item)
		}
	}
}

func TestInspectionNativeFiles(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "缓存.bin")
	if err := os.WriteFile(file, []byte("sample"), 0600); err != nil {
		t.Fatal(err)
	}
	r, err := InspectPaths([]string{file, root, filepath.Join(root, "missing")})
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		if r.Items[0].Attributes == nil || *r.Items[0].Attributes&0x10 != 0 {
			t.Fatal("file attributes missing")
		}
		if r.Items[1].Attributes == nil || *r.Items[1].Attributes&0x10 == 0 {
			t.Fatal("directory attribute missing")
		}
	} else if r.Items[0].Error == "" {
		t.Fatal("non-Windows native inspection must fail closed")
	}
	if r.Items[2].Error == "" || r.Items[2].Attributes != nil {
		t.Fatal("missing file accepted")
	}
}
