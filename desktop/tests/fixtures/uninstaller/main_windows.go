//go:build windows

// The test executable removes only its uniquely marked fixture registration.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/registry"
)

func safeRemoveFixtureRegistration(token, marker string) error {
	if os.Getenv("GITHUB_ACTIONS") != "true" || len(token) != 36 || strings.ContainsAny(token, `\\/:`) {
		return fmt.Errorf("fixture execution is restricted to hosted CI")
	}
	rel, err := filepath.Rel(os.TempDir(), marker)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return fmt.Errorf("marker is outside the fixture temp directory")
	}
	keyPath := `Software\Microsoft\Windows\CurrentVersion\Uninstall\MoleIntegrationFixture-` + token
	key, err := registry.OpenKey(registry.CURRENT_USER, keyPath, registry.QUERY_VALUE)
	if err != nil {
		return err
	}
	owner, _, readErr := key.GetStringValue("MoleFixture")
	closeErr := key.Close()
	if readErr != nil {
		return readErr
	}
	if closeErr != nil {
		return closeErr
	}
	if owner != token {
		return fmt.Errorf("registration is not owned by this fixture")
	}
	if err := registry.DeleteKey(registry.CURRENT_USER, keyPath); err != nil {
		return err
	}
	return os.WriteFile(marker, []byte("fixture uninstalled"), 0600)
}

func main() {
	token := os.Getenv("MOLE_FIXTURE_TOKEN")
	if len(os.Args) != 3 || os.Args[1] != "--mole-fixture" || os.Args[2] != token {
		os.Exit(42)
	}
	if err := safeRemoveFixtureRegistration(token, os.Getenv("MOLE_FIXTURE_MARKER")); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(43)
	}
}
