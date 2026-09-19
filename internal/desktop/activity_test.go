package desktop

import (
	"runtime"
	"sort"
	"testing"
)

func TestActivityIsExplicitAndReadOnly(t *testing.T) {
	r := ReadActivity()
	if r.Platform != runtime.GOOS || r.Names == nil || r.Warnings == nil {
		t.Fatalf("invalid shape: %+v", r)
	}
	if runtime.GOOS == "windows" {
		if !r.OK || len(r.Names) == 0 || !sort.StringsAreSorted(r.Names) {
			t.Fatalf("native snapshot failed: %+v", r)
		}
	} else if r.OK || len(r.Warnings) == 0 {
		t.Fatal("must not pretend Windows owners are idle on non-Windows")
	}
}
