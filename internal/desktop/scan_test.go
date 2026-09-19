package desktop

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func fixture(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string]string{"one.txt": "123", "资料/中文.txt": "12345", "资料/deep/nested.bin": "1234567", ".hidden": "12"} {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestScanAccurateReadOnly(t *testing.T) {
	root := fixture(t)
	before := snapshot(t, root)
	r, err := Scan(context.Background(), root, ScanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if r.Bytes != 17 || r.Files != 4 || r.Directories != 2 || r.Partial {
		t.Fatalf("unexpected scan: %+v", r)
	}
	if r.Entries[0].Name != "资料" || r.Entries[0].Size != 12 {
		t.Fatalf("directory aggregation: %+v", r.Entries)
	}
	if r.LargeFiles[0].Size != 7 {
		t.Fatal("nested large files missing")
	}
	if !reflect.DeepEqual(before, snapshot(t, root)) {
		t.Fatal("scan changed file contents")
	}
}

func snapshot(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(root, func(path string, e os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !e.IsDir() {
			b, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			out[path] = string(b)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestEmptyMissingAndFileRoots(t *testing.T) {
	empty, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	r, err := Scan(context.Background(), empty, ScanOptions{})
	if err != nil || r.Bytes != 0 || r.Partial || len(r.Entries) != 0 {
		t.Fatalf("empty: %+v %v", r, err)
	}
	root := fixture(t)
	for _, path := range []string{"relative", filepath.Join(root, "missing"), filepath.Join(root, "one.txt")} {
		if _, err := Scan(context.Background(), path, ScanOptions{}); err == nil {
			t.Fatalf("accepted invalid root %s", path)
		}
	}
}

func TestCancellationAndLimitAreExplicit(t *testing.T) {
	root := fixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r, err := Scan(ctx, root, ScanOptions{})
	if err != nil || !r.Cancelled || !r.Partial || r.Bytes != 0 {
		t.Fatalf("cancel: %+v %v", r, err)
	}
	r, err = Scan(context.Background(), root, ScanOptions{MaxItems: 2})
	if err != nil || !r.LimitReached || !r.Partial {
		t.Fatalf("limit: %+v %v", r, err)
	}
	r, err = Scan(context.Background(), root, ScanOptions{MaxDepth: 1})
	if err != nil || !r.LimitReached || r.Skipped["depth"] != 1 {
		t.Fatalf("depth: %+v %v", r, err)
	}
}

func TestLinksDoNotEscapeOrLoop(t *testing.T) {
	root := fixture(t)
	outside := fixture(t)
	if err := os.Symlink(outside, filepath.Join(root, "outside")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := os.Symlink(root, filepath.Join(root, "loop")); err != nil {
		t.Fatal(err)
	}
	r, err := Scan(context.Background(), root, ScanOptions{})
	if err != nil || r.Bytes != 17 || r.Skipped["link"] != 2 || !r.Partial {
		t.Fatalf("links: %+v %v", r, err)
	}
	if _, err := Scan(context.Background(), filepath.Join(root, "outside"), ScanOptions{}); err == nil {
		t.Fatal("symlink root accepted")
	}
	if _, err := Scan(context.Background(), filepath.Join(root, "outside", "资料"), ScanOptions{}); err == nil {
		t.Fatal("symlink ancestor accepted")
	}
}

func TestProgressSnapshotAndBoundedResults(t *testing.T) {
	root := fixture(t)
	var updates []ScanResult
	r, err := Scan(context.Background(), root, ScanOptions{Progress: func(p ScanResult) { updates = append(updates, p) }})
	if err != nil || len(updates) < 2 || updates[0].Bytes != 0 || updates[len(updates)-1].Bytes != r.Bytes {
		t.Fatalf("progress: %+v %v", updates, err)
	}
	items := []Entry{}
	for i := 0; i < 500; i++ {
		items = keepLargest(items, Entry{Size: int64(i)}, 100)
	}
	if len(items) != 100 || items[0].Size != 499 || items[99].Size != 400 {
		t.Fatal("top list is not bounded/sorted")
	}
}
