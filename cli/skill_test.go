package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestSkillInstall(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	// Installation must not initialize the API client, even with invalid configuration.
	t.Setenv("DRIFTVERK_CONTROL_PLANE_URL", "invalid")
	var output bytes.Buffer
	a := newApp(context.Background(), &bytes.Buffer{}, &output, &output)
	if err := a.execute([]string{"skill", "install"}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, ".agents", "skills", "driftverk-cli", "SKILL.md")
	content, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(content, cliSkill) {
		t.Fatalf("installed content mismatch: %v", err)
	}
	if err := a.execute([]string{"skill", "install"}); err != nil {
		t.Fatalf("repeat install: %v", err)
	}
	if err := os.WriteFile(path, []byte("custom instructions"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := a.execute([]string{"skill", "install"}); err == nil {
		t.Fatal("overwrote customized skill")
	}
	content, _ = os.ReadFile(path)
	if string(content) != "custom instructions" {
		t.Fatal("customized skill changed")
	}
	if err := a.execute([]string{"skill", "install", "--agent", "claude"}); err != nil {
		t.Fatal(err)
	}
	content, err = os.ReadFile(filepath.Join(home, ".claude", "skills", "driftverk-cli", "SKILL.md"))
	if err != nil || !bytes.Equal(content, cliSkill) {
		t.Fatalf("Claude install mismatch: %v", err)
	}
	custom := filepath.Join(t.TempDir(), "skills with spaces")
	if err := a.execute([]string{"skill", "install", "--path", custom}); err != nil {
		t.Fatal(err)
	}
	content, err = os.ReadFile(filepath.Join(custom, "driftverk-cli", "SKILL.md"))
	if err != nil || !bytes.Equal(content, cliSkill) {
		t.Fatalf("custom path mismatch: %v", err)
	}
	for _, args := range [][]string{{"skill", "install", "--agent", "unknown"}, {"skill", "remove"}, {"skill", "install", "unexpected"}, {"skill", "install", "--unknown"}} {
		if err := a.execute(args); err == nil {
			t.Fatalf("accepted invalid command: %v", args)
		}
	}
}
