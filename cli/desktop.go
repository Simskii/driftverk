package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"time"
)

func shellArgument(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'" }

func (a *app) desktopCommand(command string, args []string) error {
	f := a.flags(command)
	noBrowserHelp := "Print the viewer URL without opening it"
	if command == "prompt" {
		noBrowserHelp = "Do not open setup login URLs automatically"
	}
	noBrowser := f.Bool("no-browser", false, noBrowserHelp)
	var record *bool
	var output, cwd *string
	var stop *bool
	if command != "prompt" {
		stop = f.Bool("stop", false, "Stop the shared desktop and all its services")
	}
	if command == "prompt" {
		record = f.Bool("record", false, "Record the shared desktop and download an MP4")
		output = f.String("output", "", "Local MP4 path; requires --record; never overwrites a file")
		cwd = f.String("cwd", "", "Working directory inside the environment; defaults to its configured workspace")
	}
	count := 1
	if command == "prompt" {
		count = 2
	}
	if err := arguments(f, args, count, count); err != nil {
		return err
	}
	if command == "prompt" {
		if strings.TrimSpace(f.Arg(1)) == "" || len(f.Arg(1)) > 8000 || strings.ContainsRune(f.Arg(1), 0) {
			return errors.New("use a prompt of 1–8000 bytes")
		}
		if *cwd != "" && (!strings.HasPrefix(*cwd, "/") || len(*cwd) > 1000 || strings.ContainsRune(*cwd, 0)) {
			return errors.New("--cwd must be an absolute environment path")
		}
		if *output != "" && !*record {
			return errors.New("--output requires --record")
		}
	}
	alias, err := a.sshConfig(f.Arg(0), *noBrowser)
	if err != nil {
		return err
	}
	listing, err := a.client.get("/api/environments", nil)
	if err != nil {
		return err
	}
	selected, err := selectEnvironment(listing, f.Arg(0))
	if err != nil {
		return err
	}
	if command == "prompt" {
		return a.runPrompt(alias, f.Arg(1), fallback(*cwd, fallback(str(selected, "workspace_path"), "/workspace")), *record, *output)
	}
	if *stop {
		_, err = a.remote(alias, "driftverk-browser stop", false, false)
		return err
	}
	if selected["preview_enabled"] == false {
		return errors.New("enable HTTP preview in environment Settings to open the desktop")
	}
	action := "start"
	if command == "browser" {
		action = "focus"
	}
	if _, err = a.remote(alias, "command -v driftverk-browser >/dev/null || { echo 'Use an image with Driftverk desktop tooling installed.' >&2; exit 1; }; driftverk-browser "+action, false, false); err != nil {
		return err
	}
	result, err := a.client.get("/api/environments/"+url.PathEscape(str(selected, "id"))+"/ports/6080/preview", object{})
	if err != nil {
		return err
	}
	viewer, err := url.Parse(str(result, "url"))
	if err != nil || viewer.Host == "" || (viewer.Scheme != "https" && viewer.Scheme != "http") {
		return errors.New("server returned an invalid preview URL")
	}
	query := viewer.Query()
	query.Set("view", command)
	viewer.RawQuery = query.Encode()
	a.print("%s", viewer.String())
	a.print("Anyone with this link can control the desktop until %s", str(result, "expires_at"))
	if !*noBrowser {
		return a.open(viewer.String())
	}
	return nil
}

func (a *app) runPrompt(alias, prompt, cwd string, record bool, output string) error {
	id := randomSuffix(24)
	payload, _ := json.Marshal(object{"id": id, "prompt": prompt, "cwd": cwd, "record": record, "heartbeat": true})
	encoded := base64.StdEncoding.EncodeToString(payload)
	if len(encoded) > 15000 {
		return errors.New("prompt is too large for the SSH command; shorten it and retry")
	}
	var file *os.File
	var err error
	if record {
		if output == "" {
			output = "driftverk-" + id + ".mp4"
		}
		file, err = os.OpenFile(output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return err
		}
		defer file.Close()
	}
	a.print("Run: %s", id)
	// Heartbeats let the remote supervisor detect a lost client even when Docker keeps exec alive.
	runErr := a.task(a.ctx, "ssh", "-T", alias, "command -v driftverk-prompt >/dev/null || { echo 'Use an image with Driftverk desktop tooling installed.' >&2; exit 1; }; exec driftverk-prompt run "+shellArgument(encoded))
	if record {
		// Give the remote supervisor time to finalize the MP4 even after Ctrl+C.
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		err = a.download(ctx, file, "ssh", "-T", alias, "driftverk-prompt export "+shellArgument(id))
		if err == nil {
			err = file.Sync()
		}
		info, statErr := file.Stat()
		if err == nil && (statErr != nil || info.Size() == 0) {
			err = errors.New("recording was empty")
		}
		if err != nil {
			file.Close()
			os.Remove(output)
			a.print("Recording could not be downloaded. Remote run: ~/.local/share/driftverk/runs/%s", id)
			if runErr != nil {
				return fmt.Errorf("agent run failed: %w; recording download: %v", runErr, err)
			}
			return fmt.Errorf("recording download failed: %w", err)
		}
		a.print("Recording saved: %s", output)
	}
	return runErr
}

func downloadCommand(ctx context.Context, writer io.Writer, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdout = writer
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// Codex is noninteractive. Keep stdin for a liveness heartbeat rather than terminal input.
func taskCommand(ctx context.Context, stdout, stderr io.Writer, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdout, cmd.Stderr = stdout, stderr
	input, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	if err = cmd.Start(); err != nil {
		input.Close()
		return err
	}
	done := make(chan struct{})
	defer close(done)
	defer input.Close()
	go func() {
		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()
		for {
			if _, err := io.WriteString(input, "heartbeat\n"); err != nil {
				return
			}
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return cmd.Wait()
}
