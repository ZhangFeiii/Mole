package main

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestCommandAllowlist(t *testing.T) {
	for _, args := range [][]string{nil, {"clean"}, {"uninstall"}, {"optimize"}, {"scan"}, {"status", "extra"}} {
		if err := run(args, &bytes.Buffer{}); err == nil {
			t.Fatalf("accepted command: %v", args)
		}
	}
}

func TestScanProtocol(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := run([]string{"scan", root}, &out); err != nil {
		t.Fatal(err)
	}
	lines := bytes.Split(bytes.TrimSpace(out.Bytes()), []byte("\n"))
	var last struct {
		Type string `json:"type"`
		Data struct {
			Root string `json:"root"`
		} `json:"data"`
	}
	for _, line := range lines {
		if err := json.Unmarshal(line, &last); err != nil {
			t.Fatal(err)
		}
	}
	if last.Type != "result" || last.Data.Root != root {
		t.Fatalf("invalid protocol: %s", out.String())
	}
}
