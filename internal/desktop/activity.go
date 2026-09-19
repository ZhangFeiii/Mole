package desktop

import "runtime"

// Activity is a point-in-time read-only process-name snapshot, not proof that
// a program cannot start later. Callers recheck before each cache mutation.
type Activity struct {
	Platform string   `json:"platform"`
	OK       bool     `json:"ok"`
	Names    []string `json:"names"`
	Warnings []string `json:"warnings"`
}

func ReadActivity() Activity {
	result := Activity{Platform: runtime.GOOS, Names: []string{}, Warnings: []string{}}
	names, err := nativeActivity()
	if err != nil {
		result.Warnings = append(result.Warnings, err.Error())
		return result
	}
	result.OK = true
	result.Names = names
	return result
}
