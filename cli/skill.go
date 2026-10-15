package main

import (
	"bytes"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

//go:embed skills/driftverk-cli/SKILL.md
var cliSkill []byte

func (a *app) skill(args []string) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		a.print("Usage: driftverk skill install [--agent codex|claude] [--path <skills-directory>]")
		return nil
	}
	if args[0] != "install" {
		return fmt.Errorf("unknown skill command: %s; use driftverk skill install", args[0])
	}
	f := a.flags("skill install")
	agent := f.String("agent", "codex", "Agent to install for: codex or claude")
	directory := f.String("path", "", "Override the agent skills directory; creates driftverk-cli/SKILL.md inside it")
	if err := arguments(f, args[1:], 0, 0); err != nil {
		return err
	}
	if *agent != "codex" && *agent != "claude" {
		return fmt.Errorf("unknown agent: %s; choose codex or claude", *agent)
	}
	if *directory == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		folder := ".agents"
		if *agent == "claude" {
			folder = ".claude"
		}
		*directory = filepath.Join(home, folder, "skills")
	}
	destination, err := filepath.Abs(filepath.Join(*directory, "driftverk-cli", "SKILL.md"))
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0755); err != nil {
		return err
	}
	// Exclusive creation protects existing edits and symlinks, including dangling links.
	file, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if errors.Is(err, os.ErrExist) {
		existing, readErr := os.ReadFile(destination)
		if readErr == nil && bytes.Equal(existing, cliSkill) {
			a.print("Skill already installed: %s", destination)
			return nil
		}
		return fmt.Errorf("skill already exists at %s; compare it with the docs download or use --path to install elsewhere", destination)
	}
	if err != nil {
		return err
	}
	_, writeErr := file.Write(cliSkill)
	closeErr := file.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	a.print("Installed Driftverk CLI skill: %s", destination)
	return nil
}
