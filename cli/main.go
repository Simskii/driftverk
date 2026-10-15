// Driftverk is a native API client and system OpenSSH launcher.
package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/pflag"
	"golang.org/x/term"
)

const version = "0.8.1"

type object = map[string]any

func str(m object, key string) string { s, _ := m[key].(string); return s }
func obj(m object, key string) object { v, _ := m[key].(map[string]any); return v }
func rows(m object, key string) []object {
	var out []object
	for _, v := range array(m[key]) {
		if item, ok := v.(map[string]any); ok {
			out = append(out, item)
		}
	}
	return out
}
func array(v any) []any { a, _ := v.([]any); return a }
func number(m object, key string) float64 {
	switch n := m[key].(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case string:
		v, _ := strconv.ParseFloat(n, 64)
		return v
	}
	return 0
}
func fallback(value, otherwise string) string {
	if value != "" {
		return value
	}
	return otherwise
}
func env(name, otherwise string) string { return fallback(os.Getenv(name), otherwise) }

type app struct {
	ctx           context.Context
	in            *bufio.Reader
	out, errOut   io.Writer
	interactive   bool
	client        *client
	run           func(context.Context, bool, string, ...string) (string, error)
	download      func(context.Context, io.Writer, string, ...string) error
	task          func(context.Context, string, ...string) error
	open          func(string) error
	sleep         func(time.Duration) error
	setupOverride func(bool) error // injected by command contract tests
}

func newApp(ctx context.Context, input io.Reader, output, errorOutput io.Writer) *app {
	a := &app{ctx: ctx, in: bufio.NewReader(input), out: output, errOut: errorOutput}
	a.run = func(ctx context.Context, capture bool, name string, args ...string) (string, error) {
		cmd := exec.CommandContext(ctx, name, args...)
		if name == "git" {
			cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=", "SSH_ASKPASS=")
		}
		if capture {
			var stdout, stderr bytes.Buffer
			cmd.Stdout, cmd.Stderr = &stdout, &stderr
			err := cmd.Run()
			return stdout.String(), err
		}
		cmd.Stdin, cmd.Stdout, cmd.Stderr = input, output, errorOutput
		return "", cmd.Run()
	}
	a.download = downloadCommand
	a.task = func(ctx context.Context, name string, args ...string) error {
		return taskCommand(ctx, output, errorOutput, name, args...)
	}
	a.open = openBrowser
	a.sleep = func(d time.Duration) error {
		timer := time.NewTimer(d)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			return nil
		}
	}
	return a
}
func (a *app) print(format string, args ...any) { fmt.Fprintf(a.out, format+"\n", args...) }
func (a *app) ask(label string) (string, error) {
	fmt.Fprint(a.out, label+": ")
	s, err := a.in.ReadString('\n')
	if err != nil && !(errors.Is(err, io.EOF) && len(s) > 0) {
		return "", fmt.Errorf("input cancelled: %w", err)
	}
	return strings.TrimSpace(s), nil
}
func (a *app) flags(command string) *pflag.FlagSet {
	f := pflag.NewFlagSet("driftverk "+command, pflag.ContinueOnError)
	f.SetOutput(a.out)
	return f
}
func arguments(f *pflag.FlagSet, args []string, min, max int) error {
	if err := f.Parse(args); err != nil {
		return err
	}
	if f.NArg() < min || f.NArg() > max {
		return fmt.Errorf("usage: %s; expected %d–%d arguments (see --help)", f.Name(), min, max)
	}
	return nil
}
func (a *app) execute(args []string) error {
	if len(args) == 0 {
		args = []string{"help"}
	}
	command := args[0]
	rest := args[1:]
	if command == "version" || command == "--version" {
		a.print("driftverk %s", version)
		return nil
	}
	if command == "help" || command == "--help" || command == "-h" {
		a.print(help)
		return nil
	}
	if command == "skill" {
		return a.skill(rest)
	}
	known := " browser desktop prompt create ls logs start stop whoami preview delete fork cost connect ssh-config ssh setup signup login verify org key logout "
	if !strings.Contains(known, " "+command+" ") {
		return fmt.Errorf("unknown command: %s", command)
	}
	if command == "ssh" {
		return a.ssh(rest)
	}
	if a.client == nil {
		var err error
		a.client, err = newClient(a.ctx)
		if err != nil {
			return err
		}
	}
	switch command {
	case "browser", "desktop", "prompt":
		return a.desktopCommand(command, rest)
	case "create":
		return a.create(rest)
	case "connect", "ssh-config":
		f := a.flags(command)
		noBrowser := f.Bool("no-browser", false, "Print login URLs without opening a browser")
		if err := arguments(f, rest, 1, 1); err != nil {
			return err
		}
		if command == "connect" {
			return a.connect(f.Arg(0), *noBrowser)
		}
		_, err := a.sshConfig(f.Arg(0), *noBrowser)
		return err
	case "setup", "signup", "login", "verify", "org", "key", "logout":
		f := a.flags(command)
		noBrowser := f.Bool("no-browser", false, "Print login URLs without opening a browser")
		if err := arguments(f, rest, 0, 0); err != nil {
			return err
		}
		switch command {
		case "setup":
			if err := a.ensureSetup(*noBrowser); err != nil {
				return err
			}
			a.print("Setup complete. Next: driftverk create")
			return nil
		case "signup", "login", "verify":
			return a.login(*noBrowser)
		case "org":
			return a.organization(false)
		case "key":
			return a.addKey()
		case "logout":
			if _, err := a.client.request("/api/auth/sign-out", object{}); err != nil {
				return err
			}
			if err := a.client.clearToken(); err != nil {
				return err
			}
			a.print("Signed out.")
			return nil
		}
	}
	return a.environmentCommand(command, rest)
}
func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	a := newApp(ctx, os.Stdin, os.Stdout, os.Stderr)
	a.interactive = term.IsTerminal(int(os.Stdin.Fd())) && term.IsTerminal(int(os.Stdout.Fd()))
	if err := a.execute(os.Args[1:]); err != nil && !errors.Is(err, pflag.ErrHelp) {
		fmt.Fprintln(os.Stderr, "Error:", err)
		if ctx.Err() != nil {
			os.Exit(130)
		}
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			os.Exit(exit.ExitCode())
		}
		os.Exit(1)
	}
}

const help = `Usage: driftverk <command>
  create [name]         Create from GitHub, --empty, --example or --snapshot
  connect <environment> Configure SSH and start a remote agent or shell
  ls                    List environments in the active organization
  fork <environment> <name>  Create from a new snapshot
  cost                  Show balance and organization usage
  logs <environment>    Show setup and application logs
  start <environment>   Start an environment
  stop <environment>    Stop an environment
  browser <environment>  Start and open the shared browser
  desktop <environment>  Start and open the shared desktop
  prompt <environment> "task" [--record]  Run Codex in the shared browser
  preview <environment> [--port 3000]  Print a preview link
  delete <environment>  Delete after typing its name to confirm
  whoami                Show account and active organization
  version               Show CLI version
  skill install         Install the AI skill locally, without signing in
  setup                 Prepare account and SSH key; create does this automatically
  login [--no-browser]  Sign in or create an account in your browser
  signup                Open browser signup and login
  verify                Open browser login to verify your account
  org                   Create or select an organization
  key                   Register a public SSH key
  logout                Revoke the CLI session
  ssh-config <environment>  Add an SSH host for editors
  ssh <environment> [-- <command>]  Connect with OpenSSH

Run driftverk <command> --help for options.`
