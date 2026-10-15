//go:build !windows

package main

import (
	"os"
	"os/exec"
	"runtime"
)

func platformConfigDir(legacy string) (string, error) { return legacy, nil }
func protect(path string, directory bool) error {
	if directory {
		return os.Chmod(path, 0700)
	}
	return os.Chmod(path, 0600)
}
func legacySecret(string) (string, error) { return "", nil }
func removeLegacySecret(string) error     { return nil }
func openBrowser(url string) error {
	name := "xdg-open"
	if runtime.GOOS == "darwin" {
		name = "open"
	}
	return exec.Command(name, url).Run()
}
