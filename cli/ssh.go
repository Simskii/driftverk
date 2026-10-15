package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

var hostPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9.-]*$`)

func sshAddress() (string, string, error) {
	host := env("DRIFTVERK_SSH_HOST", "ssh.app.driftverk.com")
	port := env("DRIFTVERK_SSH_PORT", "2222")
	if !hostPattern.MatchString(host) {
		return "", "", errors.New("invalid SSH hostname")
	}
	n, err := strconv.Atoi(port)
	if err != nil || validPort(n) != nil {
		return "", "", errors.New("invalid SSH port")
	}
	return host, port, nil
}
func (a *app) ssh(args []string) error {
	if len(args) == 1 && (args[0] == "--help" || args[0] == "-h") {
		a.print("Usage: driftverk ssh <environment|organization/environment> [-- <command>]")
		return nil
	}
	if len(args) == 0 {
		return errors.New("provide an environment name")
	}
	target := strings.ReplaceAll(args[0], "/", ".")
	parts := strings.Split(target, ".")
	if len(parts) > 2 {
		return errors.New("use environment or organization/environment")
	}
	for _, p := range parts {
		if !namePattern.MatchString(p) {
			return errors.New("use environment or organization/environment")
		}
	}
	host, port, err := sshAddress()
	if err != nil {
		return err
	}
	identity, err := identityPath()
	if err != nil {
		return err
	}
	options := []string{}
	if _, err := os.Stat(identity); err == nil {
		options = append(options, "-i", identity)
	}
	options = append(options, "-p", port, "-l", target, "--", host)
	remote := args[1:]
	if len(remote) > 0 && remote[0] == "--" {
		remote = remote[1:]
	}
	options = append(options, remote...)
	_, err = a.run(a.ctx, false, "ssh", options...)
	return err
}
func sshBlock(original, alias, host, port, identity string) (string, error) {
	// OpenSSH accepts forward slashes on Windows, including paths with spaces.
	identity = strings.ReplaceAll(identity, `\`, "/")
	if strings.ContainsAny(identity, "\"\n\r%$") {
		return "", errors.New("unsupported characters in SSH identity path")
	}
	start := "# BEGIN Driftverk " + alias
	end := "# END Driftverk " + alias
	original = strings.ReplaceAll(original, "\r\n", "\n")
	pattern := regexp.MustCompile(`(?ms)^` + regexp.QuoteMeta(start) + `\n.*?^` + regexp.QuoteMeta(end) + `\n?`)
	remaining := original
	if strings.Contains(original, start) || strings.Contains(original, end) {
		if strings.Count(original, start) != 1 || strings.Count(original, end) != 1 || !pattern.MatchString(original) {
			return "", errors.New("malformed Driftverk SSH config block; fix it before retrying")
		}
		remaining = pattern.ReplaceAllString(original, "")
	}
	for _, line := range strings.Split(remaining, "\n") {
		// Host aliases cannot contain whitespace; quoted aliases are also checked.
		line = strings.SplitN(line, "#", 2)[0]
		line = strings.ReplaceAll(line, "=", " ")
		fields := strings.Fields(line)
		if len(fields) > 1 && strings.EqualFold(fields[0], "host") {
			for _, name := range fields[1:] {
				if strings.EqualFold(strings.Trim(name, "\"'"), alias) {
					return "", fmt.Errorf("SSH alias already exists outside the Driftverk block: %s", alias)
				}
			}
		}
	}
	block := fmt.Sprintf("%s\nHost %s\n    HostName %s\n    User %s\n    Port %s\n    IdentityFile \"%s\"\n    IdentitiesOnly yes\nHost *\n%s\n", start, alias, host, strings.TrimPrefix(alias, "driftverk-"), port, identity, end)
	return block + remaining, nil
}
func (a *app) sshConfig(environment string, noBrowser bool) (string, error) {
	if err := a.ensureSetup(noBrowser); err != nil {
		return "", err
	}
	session, err := a.client.get("/api/auth/get-session", nil)
	if err != nil {
		return "", err
	}
	organizations, err := a.client.organizations()
	if err != nil {
		return "", err
	}
	var organization object
	for _, item := range organizations {
		if str(item, "id") == str(obj(session, "session"), "activeOrganizationId") {
			organization = item
		}
	}
	if organization == nil {
		return "", errors.New("select an organization with driftverk org")
	}
	listing, err := a.client.get("/api/environments", nil)
	if err != nil {
		return "", err
	}
	selected, err := selectEnvironment(listing, environment)
	if err != nil {
		return "", err
	}
	if selected["ssh_enabled"] == false {
		return "", errors.New("enable SSH for this environment in Driftverk first")
	}
	slug, name := str(organization, "slug"), str(selected, "name")
	if !namePattern.MatchString(slug) || !namePattern.MatchString(name) {
		return "", errors.New("invalid organization or environment name")
	}
	alias := "driftverk-" + slug + "." + name
	host, port, err := sshAddress()
	if err != nil {
		return "", err
	}
	identity, err := identityPath()
	if err != nil {
		return "", err
	}
	identity, err = filepath.Abs(identity)
	if err != nil {
		return "", err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	folder := filepath.Join(home, ".ssh")
	path := filepath.Join(folder, "config")
	if err = privateDir(folder); err != nil {
		return "", err
	}
	if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("SSH config is a symlink; update its target manually")
	}
	original, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return "", err
	}
	updated, err := sshBlock(string(original), alias, host, port, identity)
	if err != nil {
		return "", err
	}
	if updated != string(original) {
		if original != nil {
			backup, err := os.CreateTemp(folder, "config.driftverk-backup-")
			if err != nil {
				return "", err
			}
			backup.Close()
			if err = writePrivate(backup.Name(), original); err != nil {
				return "", err
			}
			a.print("Backup: %s", backup.Name())
		}
		if err = writePrivate(path, []byte(updated)); err != nil {
			return "", err
		}
	}
	a.print("SSH connection ready: %s", alias)
	a.print("Test: ssh %s", alias)
	a.print("Choose this host in your SSH-compatible editor: %s", alias)
	return alias, nil
}
func (a *app) remote(alias, command string, interactive, capture bool) (string, error) {
	flag := "-T"
	if interactive {
		flag = "-tt"
	}
	args := []string{flag, alias}
	if command != "" {
		args = append(args, command)
	}
	return a.run(a.ctx, capture, "ssh", args...)
}
func exitCode(err error) int {
	if err == nil {
		return 0
	}
	var e *exec.ExitError
	if errors.As(err, &e) {
		return e.ExitCode()
	}
	return -1
}

var deviceURL = regexp.MustCompile(`https://auth\.openai\.com/codex/device(?:[\s\x1b]|$)`)

func (a *app) codexLogin(alias string, noBrowser bool) error {
	a.print("Connect your OpenAI account using the link and code below.")
	cmd := exec.CommandContext(a.ctx, "ssh", "-T", alias, "codex login --device-auth")
	output, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = cmd.Stdout
	if err = cmd.Start(); err != nil {
		return err
	}
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	opened := false
	for scanner.Scan() {
		line := scanner.Text()
		a.print("%s", line)
		if !noBrowser && !opened && deviceURL.MatchString(line) {
			opened = true
			_ = a.open("https://auth.openai.com/codex/device")
		}
	}
	if err = scanner.Err(); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return err
	}
	return cmd.Wait()
}
func (a *app) connect(environment string, noBrowser bool) error {
	if !a.interactive {
		return errors.New("guided setup needs an interactive terminal. Use driftverk ssh or ssh-config instead")
	}
	a.print("You can resume this setup with: driftverk connect %s", environment)
	alias, err := a.sshConfig(environment, noBrowser)
	if err != nil {
		return err
	}
	a.print("\nWhat would you like to use?\n  1. Codex\n  2. Just the environment\n  3. Finish setup for my editor")
	choice, err := a.ask("Choose [1]")
	if err != nil {
		return err
	}
	choice = fallback(choice, "1")
	for choice != "1" && choice != "2" && choice != "3" {
		choice, err = a.ask("Choose 1, 2 or 3")
		if err != nil {
			return err
		}
	}
	if choice == "3" {
		return nil
	}
	if choice == "2" {
		_, err = a.remote(alias, "", true, false)
		return err
	}
	_, err = a.remote(alias, "command -v codex >/dev/null 2>&1 || exit 42; command -v tmux >/dev/null 2>&1 || exit 43", false, true)
	switch exitCode(err) {
	case 0:
	case 42:
		return errors.New("Codex is not installed in this image. Use a Driftverk Dev environment or install Codex, then reconnect")
	case 43:
		return errors.New("install tmux in the environment to keep Codex running after disconnecting, then retry")
	default:
		return fmt.Errorf("could not reach the environment. Try driftverk ssh %s", environment)
	}
	_, err = a.remote(alias, "codex login status", false, true)
	if exitCode(err) == 255 {
		return fmt.Errorf("SSH connection interrupted. Run driftverk connect %s to retry", environment)
	}
	if err != nil {
		if err = a.codexLogin(alias, noBrowser); err != nil {
			return fmt.Errorf("Codex sign-in did not complete. Run driftverk connect %s to retry: %w", environment, err)
		}
		if _, err = a.remote(alias, "codex login status", false, true); err != nil {
			return fmt.Errorf("could not verify Codex login. Run driftverk connect %s to retry", environment)
		}
	}
	a.print("✓ Codex connected")
	a.print("Codex will run in a persistent remote session. Reconnect with driftverk connect %s.", environment)
	a.print("For long unattended tasks, disable environment auto-stop in Driftverk first.")
	if _, err = a.ask("Press Enter to start working, or Ctrl+C to finish setup"); err != nil {
		return err
	}
	_, err = a.remote(alias, "exec tmux -L driftverk-codex new-session -A -s codex codex", true, false)
	return err
}
