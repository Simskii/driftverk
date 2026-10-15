package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDesktopCommandsOpenPrivateViewer(t *testing.T) {
	for _, command := range []string{"browser", "desktop"} {
		t.Run(command, func(t *testing.T) {
			fx := newFixture(t, "")
			fx.override = func(path string, _ object) (any, int, bool) {
				if path == "/api/environments/env1/ports/6080/preview" {
					return object{"url": "https://preview.example.test/?token=secret", "expires_at": "tomorrow"}, 200, true
				}
				return nil, 0, false
			}
			var remote, opened string
			fx.app.run = func(_ context.Context, _ bool, name string, args ...string) (string, error) {
				remote = strings.Join(args, " ")
				return "", nil
			}
			fx.app.open = func(value string) error { opened = value; return nil }
			if err := fx.app.execute([]string{command, "env1"}); err != nil {
				t.Fatal(err)
			}
			action := "start"
			if command == "browser" {
				action = "focus"
			}
			if !strings.Contains(remote, "driftverk-workspace.api") || !strings.HasSuffix(remote, "driftverk-browser "+action) {
				t.Fatal(remote)
			}
			if !strings.Contains(opened, "token=secret") || !strings.Contains(opened, "view="+command) {
				t.Fatal(opened)
			}
		})
	}
}

func TestDesktopStopDoesNotOpenViewer(t *testing.T) {
	for _, command := range []string{"desktop", "browser"} {
		fx := newFixture(t, "")
		var remote string
		fx.app.run = func(_ context.Context, _ bool, _ string, args ...string) (string, error) {
			remote = strings.Join(args, " ")
			return "", nil
		}
		fx.app.open = func(string) error { t.Fatal("stop opened a browser"); return nil }
		if err := fx.app.execute([]string{command, "env1", "--stop"}); err != nil {
			t.Fatal(err)
		}
		if !strings.HasSuffix(remote, "driftverk-browser stop") {
			t.Fatal(remote)
		}
	}
}

func TestPromptPreservesLiteralTaskAndDownloadsAfterFailure(t *testing.T) {
	fx := newFixture(t, "")
	task := "Click 'Pay'; $(touch /tmp/never)\nThen inspect `cart`"
	agentFailure := errors.New("agent failed")
	var identifier string
	fx.app.task = func(_ context.Context, _ string, args ...string) error {
		command := args[len(args)-1]
		encoded := strings.Trim(strings.Split(command, "exec driftverk-prompt run ")[1], "'")
		data, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			t.Fatal(err)
		}
		var payload object
		if err = json.Unmarshal(data, &payload); err != nil {
			t.Fatal(err)
		}
		if payload["prompt"] != task || payload["record"] != true {
			t.Fatal(payload)
		}
		identifier = str(payload, "id")
		return agentFailure
	}
	fx.app.download = func(ctx context.Context, w io.Writer, _ string, args ...string) error {
		if ctx.Err() != nil || !strings.Contains(strings.Join(args, " "), identifier) {
			t.Fatal(args)
		}
		_, err := w.Write([]byte("fixture-video"))
		return err
	}
	output := filepath.Join(t.TempDir(), "proof.mp4")
	err := fx.app.execute([]string{"prompt", "api", task, "--record", "--output", output})
	if !errors.Is(err, agentFailure) {
		t.Fatal(err)
	}
	data, err := os.ReadFile(output)
	if err != nil || string(data) != "fixture-video" {
		t.Fatal(err, string(data))
	}
	if !strings.Contains(fx.output.String(), "Recording saved:") {
		t.Fatal(fx.output.String())
	}
}

func TestPromptNeverOverwritesRecordingAndRejectsInvalidOptions(t *testing.T) {
	fx := newFixture(t, "")
	called := false
	fx.app.run = func(context.Context, bool, string, ...string) (string, error) { called = true; return "", nil }
	output := filepath.Join(t.TempDir(), "proof.mp4")
	if err := os.WriteFile(output, []byte("existing"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := fx.app.execute([]string{"prompt", "api", "test", "--record", "--output", output}); err == nil {
		t.Fatal("overwrote recording")
	}
	if called {
		t.Fatal("agent started before output validation")
	}
	for _, args := range [][]string{{"prompt", "api", ""}, {"prompt", "api", "task", "--output", "a.mp4"}, {"prompt", "api", "task", "--cwd", "relative"}} {
		if err := fx.app.execute(args); err == nil {
			t.Fatal(args)
		}
	}
}

func TestPromptRemovesFailedDownload(t *testing.T) {
	fx := newFixture(t, "")
	fx.app.task = func(context.Context, string, ...string) error { return nil }
	fx.app.download = func(_ context.Context, w io.Writer, _ string, _ ...string) error {
		w.Write([]byte("partial"))
		return errors.New("connection lost")
	}
	output := filepath.Join(t.TempDir(), "proof.mp4")
	if err := fx.app.execute([]string{"prompt", "api", "test", "--record", "--output", output}); err == nil {
		t.Fatal("expected download error")
	}
	if _, err := os.Stat(output); !os.IsNotExist(err) {
		t.Fatal("partial file retained", err)
	}
}

func TestPromptUsesConfiguredWorkspaceWithoutRecording(t *testing.T) {
	fx := newFixture(t, "")
	fx.override = func(path string, _ object) (any, int, bool) {
		if path == "/api/environments" {
			return object{"environments": []object{{"id": "env1", "name": "api", "workspace_path": "/workspaces/project"}}}, 200, true
		}
		return nil, 0, false
	}
	fx.app.task = func(_ context.Context, _ string, args ...string) error {
		command := args[len(args)-1]
		encoded := strings.Trim(strings.Split(command, "exec driftverk-prompt run ")[1], "'")
		data, _ := base64.StdEncoding.DecodeString(encoded)
		var payload object
		if err := json.Unmarshal(data, &payload); err != nil {
			t.Fatal(err)
		}
		if payload["cwd"] != "/workspaces/project" || payload["record"] != false || payload["heartbeat"] != true {
			t.Fatal(payload)
		}
		if args[0] != "-T" {
			t.Fatal("prompt must use a binary-safe non-PTY stream", args)
		}
		return nil
	}
	fx.app.download = func(context.Context, io.Writer, string, ...string) error {
		t.Fatal("download without --record")
		return nil
	}
	if err := fx.app.execute([]string{"prompt", "api", "Inspect checkout"}); err != nil {
		t.Fatal(err)
	}
}
