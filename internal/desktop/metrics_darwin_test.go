//go:build darwin

package desktop

import (
	"testing"
)

func TestDarwinBatteryParser(t *testing.T) {
	value, err := parseDarwinBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=123)\t87%; discharging; 3:42 remaining present: true\n")
	if err != nil {
		t.Fatal(err)
	}
	if value == nil || value.Percent == nil || *value.Percent != 87 {
		t.Fatalf("unexpected battery result: %+v", value)
	}
	if value.TimeRemainingSeconds == nil || *value.TimeRemainingSeconds != 13320 {
		t.Fatalf("unexpected battery time: %+v", value.TimeRemainingSeconds)
	}
}

func TestDarwinDiskCounterParser(t *testing.T) {
	output := `
        | |   "BSD Name" = "disk0"
        | |   "Bytes (Read)" = 1234
        | |   "Bytes (Write)" = 5678
        | |   "Operations (Read)" = 12
        | |   "Operations (Write)" = 34
`
	values := parseDarwinDiskCounters(output)
	if len(values) != 1 || values[0].name != "disk0" || values[0].readBytes != 1234 || values[0].writeBytes != 5678 {
		t.Fatalf("unexpected disk counters: %+v", values)
	}
}
