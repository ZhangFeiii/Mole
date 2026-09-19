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
	if !fixtureMarkerInTemp(marker) {
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

func fixtureMarkerInTemp(marker string) bool {
	// Windows TEMP can use an 8.3 alias while Node realpath returns its long
	// name. Compare filesystem identity, never loosen the boundary to a prefix.
	if !filepath.IsAbs(marker) || filepath.Base(marker) != "completed.txt" || !strings.HasPrefix(filepath.Base(filepath.Dir(marker)), "mole-uninstall-") {
		return false
	}
	temp, err := os.Stat(os.TempDir())
	if err != nil {
		return false
	}
	parent, err := os.Stat(filepath.Dir(filepath.Dir(marker)))
	return err == nil && os.SameFile(temp, parent)
}

func main() {
	token := os.Getenv("MOLE_FIXTURE_TOKEN")
	if len(os.Args) != 3 || os.Args[1] != "--mole-fixture" || os.Args[2] != token {
		os.Exit(42)
	}
	if err := safeRemoveFixtureRegistration(token, os.Getenv("MOLE_FIXTURE_MARKER")); err != nil {
		fmt.Fprintln(os.Stderr, err)
		marker := os.Getenv("MOLE_FIXTURE_MARKER")
		if fixtureMarkerInTemp(marker) {
			if writeErr := os.WriteFile(marker+".error", []byte(err.Error()), 0600); writeErr != nil {
				fmt.Fprintln(os.Stderr, writeErr)
			}
		}
		os.Exit(43)
	}
}
