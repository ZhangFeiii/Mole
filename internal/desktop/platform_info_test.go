package desktop

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPlatformInfoDoesNotTrustSystemRootEnvironment(t *testing.T) {
	before, err := ReadPlatformInfo()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("SystemRoot", filepath.Join(t.TempDir(), "forged"))
	after, err := ReadPlatformInfo()
	if err != nil {
		t.Fatal(err)
	}
	if after != before || after.Schema != 1 || after.Platform != runtime.GOOS {
		t.Fatalf("environment changed native platform info: %+v %+v", before, after)
	}
	if runtime.GOOS == "windows" {
		if !filepath.IsAbs(after.SystemDirectory) || !strings.EqualFold(filepath.Base(after.SystemDirectory), "System32") {
			t.Fatalf("unexpected system directory: %+v", after)
		}
	} else if after.SystemDirectory != "" {
		t.Fatal("must not manufacture a Windows system path")
	}
}
