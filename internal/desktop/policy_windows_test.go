//go:build windows

package desktop

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
)

type attributeInfo struct {
	os.FileInfo
	attributes uint32
}

func (a attributeInfo) Sys() any {
	return &syscall.Win32FileAttributeData{FileAttributes: a.attributes}
}

func TestCloudAndReparsePolicy(t *testing.T) {
	f, err := os.Stat(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		attributes uint32
		reason     string
	}{{0, ""}, {0x400, "link"}, {0x1000, "cloud"}, {0x40000, "cloud"}, {0x400000, "cloud"}} {
		if got := skipReason("", attributeInfo{f, tc.attributes}); got != tc.reason {
			t.Fatalf("attributes %x: %s", tc.attributes, got)
		}
	}
}

func TestWindowsJunctionNotFollowed(t *testing.T) {
	root := fixture(t)
	outside := fixture(t)
	link := filepath.Join(root, "junction")
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, outside).CombinedOutput(); err != nil {
		t.Fatalf("junction fixture: %v %s", err, out)
	}
	info, err := os.Lstat(link)
	if err != nil {
		t.Fatal(err)
	}
	if skipReason(link, info) != "link" {
		t.Fatal("junction not excluded")
	}
}
