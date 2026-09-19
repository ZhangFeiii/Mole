package desktop

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestUnsafeAncestorNeverTouchesDescendant(t *testing.T) {
	base := filepath.Join(t.TempDir(), "parent")
	blocked := filepath.Join(base, "junction")
	target := filepath.Join(blocked, "deeper", "file.tmp")
	for _, attrs := range []uint32{0x410, 0x1010, 0x40010, 0x400010, 0x80} {
		calls := []string{}
		_, err := guardedAttributes(target, func(p string) (uint32, error) {
			calls = append(calls, p)
			if p == blocked {
				return attrs, nil
			}
			if p == target || p == filepath.Dir(target) {
				t.Fatalf("unsafe descendant was probed: %s", p)
			}
			return 0x10, nil
		})
		if err == nil {
			t.Fatal("unsafe ancestor accepted")
		}
		if calls[len(calls)-1] != blocked {
			t.Fatalf("probe did not stop at ancestor: %v", calls)
		}
	}
}

func TestMissingAncestorStopsBeforeTarget(t *testing.T) {
	root := filepath.Join(t.TempDir(), "missing")
	target := filepath.Join(root, "child.tmp")
	_, err := guardedAttributes(target, func(p string) (uint32, error) {
		if p == root {
			return 0, os.ErrNotExist
		}
		if p == target {
			t.Fatal("target probed after missing parent")
		}
		return 0x10, nil
	})
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("lost cause: %v", err)
	}
}

func TestFinalReparseAttributesMayBeReportedWithoutOpeningDescendant(t *testing.T) {
	target := filepath.Join(t.TempDir(), "link")
	attrs, err := guardedAttributes(target, func(p string) (uint32, error) {
		if p == target {
			return 0x410, nil
		}
		return 0x10, nil
	})
	if err != nil || attrs != 0x410 {
		t.Fatalf("%x %v", attrs, err)
	}
}
