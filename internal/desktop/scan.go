// Package desktop implements the read-only data boundary for Mole Desktop.
// Unlike the original TUI, this package has no deletion or shell execution API.
package desktop

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"time"
)

const maxEntries = 200
const maxLargeFiles = 100

// Entry sizes are logical bytes, not allocated bytes or reclaimable space.
type Entry struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	Size      int64  `json:"size"`
	Directory bool   `json:"directory"`
	Modified  string `json:"modified"`
}

type ScanResult struct {
	Root         string           `json:"root"`
	Bytes        int64            `json:"bytes"`
	Files        int64            `json:"files"`
	Directories  int64            `json:"directories"`
	EntryCount   int              `json:"entryCount"`
	Entries      []Entry          `json:"entries"`
	LargeFiles   []Entry          `json:"largeFiles"`
	Skipped      map[string]int64 `json:"skipped"`
	Partial      bool             `json:"partial"`
	Cancelled    bool             `json:"cancelled"`
	LimitReached bool             `json:"limitReached"`
	ElapsedMs    int64            `json:"elapsedMs"`
}

// ScanOptions allows deterministic bounds in tests and on very large volumes.
type ScanOptions struct {
	MaxItems int64
	MaxDepth int
	Progress func(ScanResult)
}

// Scan only opens directories and reads file metadata. It never opens file
// contents, follows links, changes permissions, hydrates cloud files, or writes.
func Scan(ctx context.Context, root string, opts ScanOptions) (ScanResult, error) {
	r := ScanResult{Entries: []Entry{}, LargeFiles: []Entry{}, Skipped: map[string]int64{}}
	if !filepath.IsAbs(root) {
		return r, errors.New("scan requires an absolute directory path")
	}
	r.Root = filepath.Clean(root)
	if runtime.GOOS == "windows" && !localVolume(filepath.VolumeName(r.Root)+string(os.PathSeparator)) {
		return r, errors.New("only local fixed or removable volumes can be scanned")
	}
	info, err := os.Lstat(r.Root)
	if err != nil {
		return r, fmt.Errorf("cannot inspect scan root: %w", err)
	}
	if reason := skipReason(r.Root, info); reason != "" {
		return r, fmt.Errorf("root is not a local regular directory (%s)", reason)
	}
	if !info.IsDir() {
		return r, errors.New("scan root must be a directory")
	}
	// Reject link/junction ancestors too, rather than scanning outside a chosen root.
	for parent := filepath.Dir(r.Root); ; parent = filepath.Dir(parent) {
		pi, e := os.Lstat(parent)
		if e != nil {
			return r, fmt.Errorf("cannot inspect root ancestor: %w", e)
		}
		if reason := skipReason(parent, pi); reason != "" {
			return r, fmt.Errorf("root ancestor is not local (%s)", reason)
		}
		if filepath.Dir(parent) == parent {
			break
		}
	}
	// Hold an OS directory handle so a concurrent link swap cannot escape root.
	boundary, err := os.OpenRoot(r.Root)
	if err != nil {
		return r, fmt.Errorf("cannot bind scan root: %w", err)
	}
	defer boundary.Close()
	boundInfo, err := boundary.Stat(".")
	if err != nil || !os.SameFile(info, boundInfo) {
		return r, errors.New("scan root changed while opening")
	}
	f, err := boundary.Open(".")
	if err != nil {
		return r, fmt.Errorf("cannot read scan root: %w", err)
	}
	defer f.Close()
	if opts.MaxItems <= 0 {
		opts.MaxItems = 2_000_000
	}
	if opts.MaxDepth <= 0 {
		opts.MaxDepth = 128
	}
	start, last := time.Now(), time.Now()
	var visited int64
	progress := func(force bool) {
		r.ElapsedMs = time.Since(start).Milliseconds()
		if opts.Progress != nil && (force || time.Since(last) >= 250*time.Millisecond) {
			// Give callbacks a snapshot, not shared slices/maps that are later mutated.
			copyResult := r
			copyResult.Entries = append([]Entry{}, r.Entries...)
			copyResult.LargeFiles = append([]Entry{}, r.LargeFiles...)
			copyResult.Skipped = map[string]int64{}
			for k, v := range r.Skipped {
				copyResult.Skipped[k] = v
			}
			opts.Progress(copyResult)
			last = time.Now()
		}
	}
	stop := func() bool {
		if ctx.Err() != nil {
			r.Partial, r.Cancelled = true, true
			return true
		}
		if visited >= opts.MaxItems {
			r.Partial, r.LimitReached = true, true
			return true
		}
		return false
	}
	skip := func(reason string) { r.Skipped[reason]++; r.Partial = true }
	var walk func(string, os.FileInfo, int) int64
	walk = func(path string, fi os.FileInfo, depth int) int64 {
		if stop() {
			return 0
		}
		visited++
		if reason := skipReason(path, fi); reason != "" {
			skip(reason)
			return 0
		}
		if !sameVolume(info, fi) {
			skip("volume")
			return 0
		}
		if fi.Mode().IsRegular() {
			size := fi.Size()
			if size < 0 {
				size = 0
			}
			r.Files++
			r.Bytes += size
			r.LargeFiles = keepLargest(r.LargeFiles, Entry{Name: fi.Name(), Path: path, Size: size, Modified: fi.ModTime().UTC().Format(time.RFC3339)}, maxLargeFiles)
			progress(false)
			return size
		}
		if !fi.IsDir() {
			skip("special")
			return 0
		}
		if depth > opts.MaxDepth {
			skip("depth")
			r.LimitReached = true
			return 0
		}
		r.Directories++
		relative, e := filepath.Rel(r.Root, path)
		if e != nil {
			skip("changed")
			return 0
		}
		dir, e := boundary.Open(relative)
		if e != nil {
			skip(classifyError(e))
			return 0
		}
		defer dir.Close()
		openedInfo, e := dir.Stat()
		if e != nil || !os.SameFile(fi, openedInfo) {
			skip("changed")
			return 0
		}
		var size int64
		for !stop() {
			children, readErr := dir.ReadDir(256)
			for _, child := range children {
				if stop() {
					break
				}
				childPath := filepath.Join(path, child.Name())
				childRelative, e := filepath.Rel(r.Root, childPath)
				if e != nil {
					skip("changed")
					continue
				}
				childInfo, e := boundary.Lstat(childRelative)
				if e != nil {
					skip(classifyError(e))
					continue
				}
				size += walk(childPath, childInfo, depth+1)
			}
			progress(false)
			if readErr != nil {
				if readErr != io.EOF {
					skip(classifyError(readErr))
				}
				break
			}
		}
		return size
	}
	progress(true)
	for !stop() {
		children, readErr := f.ReadDir(256)
		for _, child := range children {
			if stop() {
				break
			}
			path := filepath.Join(r.Root, child.Name())
			fi, e := boundary.Lstat(child.Name())
			if e != nil {
				skip(classifyError(e))
				continue
			}
			r.EntryCount++
			size := walk(path, fi, 1)
			// Skipped links and placeholders are counted as exclusions, not clickable entries.
			if skipReason(path, fi) == "" && (fi.IsDir() || fi.Mode().IsRegular()) && sameVolume(info, fi) {
				r.Entries = keepLargest(r.Entries, Entry{Name: child.Name(), Path: path, Size: size, Directory: fi.IsDir(), Modified: fi.ModTime().UTC().Format(time.RFC3339)}, maxEntries)
			}
			progress(false)
		}
		if readErr != nil {
			if readErr != io.EOF {
				skip(classifyError(readErr))
			}
			break
		}
	}
	progress(true)
	return r, nil
}

func keepLargest(items []Entry, item Entry, limit int) []Entry {
	if len(items) == limit && item.Size <= items[len(items)-1].Size {
		return items
	}
	items = append(items, item)
	sort.Slice(items, func(i, j int) bool {
		if items[i].Size == items[j].Size {
			return items[i].Path < items[j].Path
		}
		return items[i].Size > items[j].Size
	})
	if len(items) > limit {
		items = items[:limit]
	}
	return items
}

func classifyError(err error) string {
	if errors.Is(err, os.ErrPermission) {
		return "permission"
	}
	if errors.Is(err, os.ErrNotExist) {
		return "changed"
	}
	return "unreadable"
}
