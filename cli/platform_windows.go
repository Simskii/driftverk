package main

import (
	"encoding/binary"
	"os"
	"os/exec"
	"path/filepath"
	"unicode/utf16"

	"github.com/danieljoos/wincred"
	"golang.org/x/sys/windows"
)

func platformConfigDir(legacy string) (string, error) {
	if _, err := os.Stat(legacy); err == nil {
		return legacy, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "driftverk"), nil
}
func protect(path string, directory bool) error {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	flags := ""
	if directory {
		flags = "OICI"
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;" + flags + ";FA;;;" + user.User.Sid.String() + ")")
	if err != nil {
		return err
	}
	acl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil)
}

// Python keyring uses a different target name and UTF-16 encoding on Windows.
func legacySecret(origin string) (string, error) {
	for _, name := range []string{"driftverk-cli", origin + "@driftverk-cli"} {
		cred, err := wincred.GetGenericCredential(name)
		if err != nil || cred.UserName != origin {
			continue
		}
		b := cred.CredentialBlob
		if len(b)%2 != 0 {
			return string(b), nil
		}
		words := make([]uint16, len(b)/2)
		for i := range words {
			words[i] = binary.LittleEndian.Uint16(b[2*i:])
		}
		return string(utf16.Decode(words)), nil
	}
	return "", nil
}
func removeLegacySecret(origin string) error {
	for _, name := range []string{"driftverk-cli", origin + "@driftverk-cli"} {
		cred, err := wincred.GetGenericCredential(name)
		if err == nil && cred.UserName == origin {
			if err = cred.Delete(); err != nil {
				return err
			}
		}
	}
	return nil
}
func openBrowser(url string) error {
	return exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", url).Run()
}
