package main

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func TestCommandAllowlist(t *testing.T) {
	for _, args := range [][]string{nil, {"clean"}, {"uninstall"}, {"optimize"}, {"scan"}, {"status", "extra"}} {
		if err := run(args, &bytes.Buffer{}); err == nil {
			t.Fatalf("accepted command: %v", args)
		}
	}
}

func TestInspectProtocolRejectsInvalidOrOversizedInput(t *testing.T) {
	inputs := []string{`{}`, `{"paths":[]}`, `{"paths":["relative"],"command":"clean"}`, `{"paths":["relative"]} {}`, strings.Repeat(" ", 2*1024*1024+1)}
	for _, input := range inputs {
		if err := runInspect(strings.NewReader(input), &bytes.Buffer{}); err == nil {
			t.Fatal("accepted invalid inspection")
		}
	}
	paths := make([]string, 2049)
	payload, err := json.Marshal(map[string]any{"paths": paths})
	if err != nil {
		t.Fatal(err)
	}
	if err := runInspect(bytes.NewReader(payload), &bytes.Buffer{}); err == nil {
		t.Fatal("accepted excessive path count")
	}
}

func TestInspectProtocolReturnsMetadataErrors(t *testing.T) {
	var out bytes.Buffer
	if err := runInspect(strings.NewReader(`{"paths":["relative"]}`), &out); err != nil {
		t.Fatal(err)
	}
	var result struct {
		Items []struct {
			Error      string  `json:"error"`
			Attributes *uint32 `json:"attributes"`
		} `json:"items"`
	}
	if err := json.Unmarshal(out.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 1 || result.Items[0].Error == "" || result.Items[0].Attributes != nil {
		t.Fatal("failed inspection appeared safe")
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
