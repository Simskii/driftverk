package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

type call struct {
	path string
	data object
}
type fixture struct {
	app      *app
	output   *bytes.Buffer
	calls    []call
	override func(string, object) (any, int, bool)
	state    int
}

func newFixture(t *testing.T, answers string) *fixture {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "config"))
	t.Setenv("DRIFTVERK_SSH_HOST", "")
	t.Setenv("DRIFTVERK_SSH_PORT", "")
	fx := &fixture{output: &bytes.Buffer{}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var data object
		if r.Method == "POST" {
			if err := json.NewDecoder(r.Body).Decode(&data); err != nil {
				t.Error(err)
			}
		}
		fx.calls = append(fx.calls, call{r.URL.Path, data})
		var result any
		if fx.override != nil {
			value, status, ok := fx.override(r.URL.Path, data)
			if ok {
				w.WriteHeader(status)
				_ = json.NewEncoder(w).Encode(value)
				return
			}
		}
		switch r.URL.Path {
		case "/api/environments":
			if data != nil {
				result = object{"id": "new"}
			} else {
				result = object{"environments": []object{{"id": "env1", "name": "api", "state": "running", "preview_port": 3000}}, "workspace": object{"role": "owner"}}
			}
		case "/api/environments/new":
			fx.state++
			if fx.state == 1 {
				result = object{"environment": object{"state": "running", "application_status": object{"status": "starting"}}}
			} else {
				result = object{"environment": object{"state": "running", "preview_port": 3000}}
			}
		case "/api/config":
			result = object{"defaultImage": "dev:1"}
		case "/api/cli/config":
			result = object{"example": object{"source_type": "image", "image": "node:22", "repository": "driftverk/example", "preview_port": 3000}}
		case "/api/auth/get-session":
			result = object{"user": object{"id": "user1", "name": "Test", "email": "qa@example.test"}, "session": object{"activeOrganizationId": "org1"}}
		case "/api/auth/organization/list":
			result = []object{{"id": "org1", "name": "Workspace", "slug": "workspace"}}
		case "/api/environments/env1/telemetry":
			result = object{"logs": []object{{"message": "ready"}}}
		case "/api/environments/env1/ports/3000/preview":
			result = object{"url": "https://preview.example.test", "expires_at": "tomorrow"}
		case "/api/billing":
			result = object{"balance_ore": 12345, "hourly_ore": 12.34, "currency": "sek"}
		case "/api/ssh-keys":
			result = object{"keys": []object{}}
		default:
			result = object{}
		}
		_ = json.NewEncoder(w).Encode(result)
	}))
	t.Cleanup(server.Close)
	a := newApp(context.Background(), strings.NewReader(answers), fx.output, fx.output)
	a.client = &client{ctx: a.ctx, origin: server.URL, http: server.Client(), dir: home, tokenPath: filepath.Join(home, "token"),
		getSecret: func(string, string) (string, error) { return "", errors.New("no keyring") }, setSecret: func(string, string, string) error { return errors.New("no keyring") }, deleteSecret: func(string, string) error { return errors.New("no keyring") }}
	a.run = func(context.Context, bool, string, ...string) (string, error) {
		return "", errors.New("command unavailable in fixture")
	}
	a.open = func(string) error { return nil }
	a.sleep = func(time.Duration) error { return nil }
	a.setupOverride = func(bool) error { return nil }
	fx.app = a
	return fx
}
func (f *fixture) created() object {
	for _, c := range f.calls {
		if c.path == "/api/environments" && c.data != nil {
			return c.data
		}
	}
	return nil
}
func TestCreateSources(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
		want object
	}{
		{"empty", []string{"--empty"}, object{"source_type": "image", "image": "dev:1"}},
		{"repository", []string{"--repository", "acme/app", "--branch", "feature", "--image", "custom:1"}, object{"repository": "acme/app", "repository_branch": "feature", "image": "custom:1"}},
		{"example", []string{"--example"}, object{"repository": "driftverk/example", "image": "node:22"}},
		{"snapshot", []string{"--snapshot", "snap1"}, object{"source_type": "snapshot", "snapshot_id": "snap1"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fx := newFixture(t, "")
			args := append([]string{"create", "new-api", "--yes", "--port", "3000"}, tc.args...)
			if err := fx.app.execute(args); err != nil {
				t.Fatal(err)
			}
			got := fx.created()
			for key, value := range tc.want {
				if got[key] != value {
					t.Errorf("%s=%v, want %v", key, got[key], value)
				}
			}
			if str(got, "name") != "new-api" {
				t.Fatal(got)
			}
			if fx.state != 2 {
				t.Fatal("did not wait for application readiness")
			}
			if !strings.Contains(fx.output.String(), "Continue setup: driftverk connect new-api") {
				t.Fatal(fx.output.String())
			}
		})
	}
}
func TestCreateRefusesInvalidOrUnconfirmedRequests(t *testing.T) {
	for _, args := range [][]string{
		{"create", "new", "--empty"}, {"create", "new", "--yes"}, {"create", "api", "--empty", "--yes"},
		{"create", "INVALID", "--empty", "--yes"}, {"create", "new", "--empty", "--yes", "--port", "0"},
		{"create", "new", "--empty", "--yes", "--port", "65536"}, {"create", "new", "--empty", "--branch", "main", "--yes"},
		{"create", "new", "--example", "--image", "custom", "--yes"}, {"create", "new", "--repository", "acme/a", "--snapshot", "x", "--yes"},
		{"create", "new", "--unknown"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			fx := newFixture(t, "")
			if err := fx.app.execute(args); err == nil {
				t.Fatal("expected rejection")
			}
			if fx.created() != nil {
				t.Fatal("unexpected create")
			}
		})
	}
}
func TestInteractiveCreateAndDecline(t *testing.T) {
	for _, answer := range []string{"n\n", "y\n"} {
		t.Run(strings.TrimSpace(answer), func(t *testing.T) {
			fx := newFixture(t, answer)
			fx.app.interactive = true
			if err := fx.app.execute([]string{"create", "new", "--empty", "--no-connect"}); err != nil {
				t.Fatal(err)
			}
			if (fx.created() != nil) != (answer == "y\n") {
				t.Fatal("wrong confirmation behavior")
			}
		})
	}
	fx := newFixture(t, "\ny\n")
	fx.app.interactive = true
	if err := fx.app.execute([]string{"create", "new", "--no-connect"}); err != nil {
		t.Fatal(err)
	}
	if fx.created()["repository"] != nil {
		t.Fatal("empty fallback cloned a repository")
	}
}

func TestInteractiveCreateAsksBeforeEditingSSHConfig(t *testing.T) {
	t.Run("declined", func(t *testing.T) {
		fx := newFixture(t, "y\nn\n")
		fx.app.interactive = true
		if err := fx.app.execute([]string{"create", "new", "--empty"}); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(filepath.Join(os.Getenv("HOME"), ".ssh", "config")); !os.IsNotExist(err) {
			t.Fatal("SSH config was changed after declining setup")
		}
		for _, want := range []string{"Set up SSH for editors? [Y/n]", "Connect: driftverk ssh new", "Editor SSH setup: driftverk ssh-config new"} {
			if !strings.Contains(fx.output.String(), want) {
				t.Fatalf("missing %q in %s", want, fx.output.String())
			}
		}
	})

	t.Run("accepted", func(t *testing.T) {
		fx := newFixture(t, "y\ny\n")
		fx.app.interactive = true
		listingCalls := 0
		fx.override = func(path string, data object) (any, int, bool) {
			if path == "/api/environments" && data == nil {
				listingCalls++
				if listingCalls == 1 {
					return object{"environments": []object{}}, 200, true
				}
				return object{"environments": []object{{"id": "new", "name": "new", "state": "running", "ssh_enabled": true}}}, 200, true
			}
			return nil, 0, false
		}
		if err := fx.app.execute([]string{"create", "new", "--empty"}); err != nil {
			t.Fatal(err)
		}
		config, err := os.ReadFile(filepath.Join(os.Getenv("HOME"), ".ssh", "config"))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(config), "Host driftverk-workspace.new") || !strings.Contains(fx.output.String(), "SSH connection ready: driftverk-workspace.new") {
			t.Fatal(fx.output.String(), string(config))
		}
	})
}

func TestMemberCreation(t *testing.T) {
	for _, mode := range []string{"enabled", "disabled", "existing", "custom", "snapshot"} {
		t.Run(mode, func(t *testing.T) {
			fx := newFixture(t, "")
			fx.override = func(path string, data object) (any, int, bool) {
				switch path {
				case "/api/environments":
					if data == nil {
						return object{"environments": []object{}, "workspace": object{"role": "member"}}, 200, true
					}
				case "/api/member-environment-settings":
					m := object{"enabled": mode != "disabled", "image": "member:1", "cpu": 2, "memory_mb": 4096}
					if mode == "existing" {
						m["existing"] = object{"name": "personal"}
					}
					return m, 200, true
				}
				return nil, 0, false
			}
			args := []string{"create", "new", "--yes", "--empty"}
			if mode == "custom" {
				args = append(args, "--image", "custom:1")
			}
			if mode == "snapshot" {
				args = []string{"create", "new", "--yes", "--snapshot", "s1"}
			}
			err := fx.app.execute(args)
			if mode == "enabled" {
				if err != nil {
					t.Fatal(err)
				}
				p := fx.created()
				if p["cpu"] != float64(2) || p["memory_mb"] != float64(4096) || p["image"] != "member:1" {
					t.Fatal(p)
				}
			} else {
				if err == nil || fx.created() != nil {
					t.Fatal("member guard failed", err)
				}
			}
		})
	}
}
func TestCreationStartupFailureRetainsRecoveryInstructions(t *testing.T) {
	fx := newFixture(t, "")
	fx.override = func(path string, _ object) (any, int, bool) {
		if path == "/api/environments/new" {
			return object{"environment": object{"state": "running", "application_status": object{"status": "failed", "message": "bad startup"}}}, 200, true
		}
		return nil, 0, false
	}
	err := fx.app.execute([]string{"create", "new", "--empty", "--yes"})
	if err == nil || !strings.Contains(err.Error(), "bad startup") {
		t.Fatal(err)
	}
	if !strings.Contains(fx.output.String(), "still exists") {
		t.Fatal(fx.output.String())
	}
}
func TestEnvironmentCommands(t *testing.T) {
	for _, command := range []string{"start", "stop", "logs", "preview", "ls", "whoami", "cost"} {
		t.Run(command, func(t *testing.T) {
			fx := newFixture(t, "")
			args := []string{command}
			if command != "ls" && command != "whoami" && command != "cost" {
				args = append(args, "api")
			}
			if err := fx.app.execute(args); err != nil {
				t.Fatal(err)
			}
			if command == "start" || command == "stop" {
				last := fx.calls[len(fx.calls)-1]
				if last.path != "/api/environments/env1/actions" || last.data["action"] != command {
					t.Fatal(last)
				}
			}
			if command == "cost" && !strings.Contains(fx.output.String(), "123.45 SEK") {
				t.Fatal(fx.output.String())
			}
		})
	}
	for _, answer := range []string{"wrong\n", "api\n"} {
		t.Run("delete-"+strings.TrimSpace(answer), func(t *testing.T) {
			fx := newFixture(t, answer)
			if err := fx.app.execute([]string{"delete", "api"}); err != nil {
				t.Fatal(err)
			}
			for _, c := range fx.calls {
				if c.data != nil && answer != "api\n" {
					t.Fatal("deleted without confirmation")
				}
			}
		})
	}
	for _, args := range [][]string{{"delete", "missing"}, {"preview", "api", "--port", "-1"}, {"stop", "api", "extra"}} {
		fx := newFixture(t, "")
		if err := fx.app.execute(args); err == nil {
			t.Fatal("expected invalid arguments")
		}
		for _, c := range fx.calls {
			if c.data != nil {
				t.Fatal("unexpected mutation")
			}
		}
	}
}
func TestForkWaitsForSnapshot(t *testing.T) {
	fx := newFixture(t, "")
	polls := 0
	fx.override = func(path string, data object) (any, int, bool) {
		if path == "/api/snapshots" {
			if data != nil {
				return object{"id": "snap"}, 200, true
			}
			polls++
			state := "building"
			if polls > 1 {
				state = "ready"
			}
			return object{"snapshots": []object{{"id": "snap", "status": state}}}, 200, true
		}
		if path == "/api/environments" && data != nil && polls < 2 {
			t.Error("created before snapshot ready")
		}
		return nil, 0, false
	}
	if err := fx.app.execute([]string{"fork", "api", "forked"}); err != nil {
		t.Fatal(err)
	}
	if fx.created()["snapshot_id"] != "snap" {
		t.Fatal(fx.created())
	}
}
func TestGitDetectionAndRemoteBranch(t *testing.T) {
	for _, remote := range []string{"git@github.com:acme/app.git", "https://github.com/acme/app.git", "ssh://git@github.com/acme/app"} {
		fx := newFixture(t, "")
		fx.app.run = func(_ context.Context, _ bool, _ string, args ...string) (string, error) {
			switch strings.Join(args, " ") {
			case "remote get-url origin":
				return remote, nil
			}
			joined := strings.Join(args, " ")
			switch {
			case strings.Contains(joined, "symbolic-ref"):
				return "feature\n", nil
			case strings.Contains(joined, "ls-remote"):
				return "abc\trefs/heads/feature\n", nil
			case strings.Contains(joined, "status"):
				return " M file\n", nil
			case strings.Contains(joined, "rev-parse"):
				return "def\n", nil
			}
			return "", nil
		}
		if err := fx.app.execute([]string{"create", "--yes"}); err != nil {
			t.Fatal(err)
		}
		if fx.created()["repository"] != "acme/app" || fx.created()["repository_branch"] != "feature" || fx.created()["name"] != "app" {
			t.Fatal(fx.created())
		}
		if !strings.Contains(fx.output.String(), "Local HEAD differs") {
			t.Fatal(fx.output.String())
		}
	}
}
func TestSSHBlockPreservesConfigAndRejectsCollisions(t *testing.T) {
	existing := "Host existing\n  HostName example.test\nHost *\n  ServerAliveInterval 30\n"
	alias := "driftverk-workspace.api"
	got, err := sshBlock(existing, alias, "ssh.example.test", "2222", `C:\Users\Test User\.config\driftverk\id_ed25519`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(got, existing) || !strings.Contains(got, `IdentityFile "C:/Users/Test User/.config/driftverk/id_ed25519"`) {
		t.Fatal(got)
	}
	again, err := sshBlock(got, alias, "ssh.example.test", "2222", `C:\Users\Test User\.config\driftverk\id_ed25519`)
	if err != nil || again != got {
		t.Fatal("not idempotent", err)
	}
	for _, bad := range []string{"Host " + alias + "\n", `Host="` + alias + "\"\n", "# BEGIN Driftverk " + alias + "\n"} {
		if _, err := sshBlock(bad, alias, "host", "22", "/key"); err == nil {
			t.Fatal("accepted collision/malformed config", bad)
		}
	}
	for _, bad := range []string{"/key\nHost evil", "/key%h", "/key\""} {
		if _, err := sshBlock("", alias, "host", "22", bad); err == nil {
			t.Fatal("accepted unsafe key path")
		}
	}
}
func TestSSHConfigAndLaunch(t *testing.T) {
	fx := newFixture(t, "")
	if err := fx.app.execute([]string{"ssh-config", "api"}); err != nil {
		t.Fatal(err)
	}
	home, _ := os.UserHomeDir()
	path := filepath.Join(home, ".ssh", "config")
	data, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(data), "User workspace.api") {
		t.Fatal(string(data), err)
	}
	if err := fx.app.execute([]string{"ssh-config", "api"}); err != nil {
		t.Fatal(err)
	}
	backups, _ := filepath.Glob(filepath.Join(home, ".ssh", "config.driftverk-backup-*"))
	if len(backups) != 0 {
		t.Fatal("idempotent config made backup")
	}
	var got []string
	fx.app.run = func(_ context.Context, _ bool, name string, args ...string) (string, error) {
		if name != "ssh" {
			t.Fatal(name)
		}
		got = args
		return "", nil
	}
	if err := fx.app.execute([]string{"ssh", "workspace/api", "--", "echo hello"}); err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, " ") != "-p 2222 -l workspace.api -- ssh.app.driftverk.com echo hello" {
		t.Fatal(got)
	}
	if err := fx.app.execute([]string{"ssh", "-oProxyCommand=evil"}); err == nil {
		t.Fatal("accepted invalid target")
	}
}
func TestSSHKeyReuseAndOrphanProtection(t *testing.T) {
	fx := newFixture(t, "")
	path, _ := identityPath()
	if err := privateDir(filepath.Dir(path)); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path+".pub", []byte("orphan"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := fx.app.ensureKey(); err == nil {
		t.Fatal("orphan public key overwritten")
	}
	if err := os.WriteFile(path, []byte("private fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	public := "ssh-ed25519 " + base64.StdEncoding.EncodeToString([]byte("key fixture"))
	fx.app.run = func(_ context.Context, _ bool, _ string, args ...string) (string, error) {
		if len(args) == 0 || args[0] != "-y" {
			t.Fatal("regenerated existing key", args)
		}
		return public, nil
	}
	if err := fx.app.ensureKey(); err != nil {
		t.Fatal(err)
	}
	for _, c := range fx.calls {
		if c.path == "/api/ssh-keys" && c.data != nil && c.data["public_key"] != public {
			t.Fatal("registered stale public file")
		}
	}
}
func TestDeviceLoginPolling(t *testing.T) {
	fx := newFixture(t, "")
	polls := 0
	var delays []time.Duration
	var opened string
	fx.app.sleep = func(d time.Duration) error { delays = append(delays, d); return nil }
	fx.app.open = func(link string) error { opened = link; return nil }
	fx.override = func(path string, _ object) (any, int, bool) {
		switch path {
		case "/api/auth/device/code":
			return object{"verification_uri": fx.app.client.origin + "/login", "user_code": "CODE", "device_code": "device", "expires_in": 600, "interval": 1}, 200, true
		case "/api/auth/device/token":
			polls++
			if polls == 1 {
				return object{"error": "authorization_pending"}, 400, true
			}
			if polls == 2 {
				return object{"error": "slow_down"}, 400, true
			}
			return object{"access_token": "test-token"}, 200, true
		}
		return nil, 0, false
	}
	if err := fx.app.login(false); err != nil {
		t.Fatal(err)
	}
	if opened != fx.app.client.origin+"/login" || polls != 3 || delays[0] != 5*time.Second || delays[2] != 10*time.Second {
		t.Fatal(opened, polls, delays)
	}
	b, err := os.ReadFile(fx.app.client.tokenPath)
	if err != nil || string(b) != "test-token" {
		t.Fatal("token not saved", err)
	}
	if err := fx.app.client.clearToken(); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(fx.app.client.tokenPath); err != nil || len(b) != 0 {
		t.Fatal("logout marker not saved", err)
	}
}
func TestDeviceLoginRejectsForeignURLAndDoesNotOpenNoBrowser(t *testing.T) {
	fx := newFixture(t, "")
	fx.override = func(path string, _ object) (any, int, bool) {
		if path == "/api/auth/device/code" {
			return object{"verification_uri": "https://evil.test/login"}, 200, true
		}
		return nil, 0, false
	}
	fx.app.open = func(string) error { t.Fatal("opened untrusted link"); return nil }
	if err := fx.app.login(false); err == nil {
		t.Fatal("accepted foreign login URL")
	}
	fx.override = func(path string, _ object) (any, int, bool) {
		if path == "/api/auth/device/code" {
			return object{"verification_uri": fx.app.client.origin + "/login", "expires_in": 600}, 200, true
		}
		return object{"access_token": "token"}, 200, true
	}
	if err := fx.app.login(true); err != nil {
		t.Fatal(err)
	}
}
func TestClientOriginAndLegacyFile(t *testing.T) {
	for _, origin := range []string{"http://evil.test", "https://user:pass@example.test", "https://example.test/path", "https://example.test?q=x", "https://example.test#x"} {
		if validOrigin(origin) == nil {
			t.Fatal("accepted", origin)
		}
	}
	for _, origin := range []string{"https://app.driftverk.com", "http://localhost:3000", "http://127.0.0.1:3000"} {
		if err := validOrigin(origin); err != nil {
			t.Fatal(err)
		}
	}
	fx := newFixture(t, "")
	dir, _ := configDir()
	sum := sha256.Sum256([]byte(fx.app.client.origin))
	path := filepath.Join(dir, fmt.Sprintf("%x.token", sum[:8]))
	if err := writePrivate(path, []byte("legacy-token")); err != nil {
		t.Fatal(err)
	}
	// Token file format and path are the Python CLI's origin-hashed format.
	b, err := os.ReadFile(path)
	if err != nil || string(b) != "legacy-token" {
		t.Fatal(err)
	}
}
func TestHTTPClientRejectsRedirectsAndSendsHeaders(t *testing.T) {
	fx := newFixture(t, "")
	fx.app.client.token = "fixture-token"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture-token" || r.Header.Get("Origin") == "" || r.Header.Get("User-Agent") != "Driftverk-CLI/"+version {
			t.Error("missing auth headers")
		}
		http.Redirect(w, r, "/unexpected", 302)
	}))
	defer server.Close()
	fx.app.client.origin = server.URL
	fx.app.client.http = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("unexpected redirect") }}
	if _, err := fx.app.client.request("/test", nil); err == nil {
		t.Fatal("followed redirect")
	}
}
func TestReadinessHonorsActiveOperationAndCancellation(t *testing.T) {
	fx := newFixture(t, "")
	fx.override = func(path string, _ object) (any, int, bool) {
		if path == "/api/environments/new" {
			return object{"environment": object{"state": "running", "active_operation": object{"type": "start"}}}, 200, true
		}
		return nil, 0, false
	}
	fx.app.sleep = func(time.Duration) error { return context.Canceled }
	if _, err := fx.app.waitEnvironment("new", "new", time.Minute); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestFallbackTokenOverridesStaleKeyringAndLogoutDoesNotResurrectIt(t *testing.T) {
	fx := newFixture(t, "")
	c := fx.app.client
	c.getSecret = func(string, string) (string, error) { return "stale-token", nil }
	if err := c.saveToken("fresh-token"); err != nil {
		t.Fatal(err)
	}
	c.token = ""
	if err := c.loadToken(); err != nil {
		t.Fatal(err)
	}
	if c.token != "fresh-token" {
		t.Fatal("loaded stale keyring token")
	}
	if err := c.clearToken(); err != nil {
		t.Fatal(err)
	}
	if err := c.loadToken(); err != nil {
		t.Fatal(err)
	}
	if c.token != "" {
		t.Fatal("logout resurrected stale keyring token")
	}
}
func TestAskAcceptsFinalLineWithoutNewline(t *testing.T) {
	fx := newFixture(t, "answer")
	s, err := fx.app.ask("Prompt")
	if err != nil || s != "answer" {
		t.Fatal(s, err)
	}
}

// This subprocess runs on each CI host and checks real process I/O, without a shell.
func TestProcessHelper(t *testing.T) {
	if os.Getenv("DRIFTVERK_TEST_HELPER") != "1" {
		return
	}
	fmt.Fprint(os.Stdout, "branch-data\n")
	fmt.Fprint(os.Stderr, "SSH warning that must not be parsed\n")
	os.Exit(0)
}
func TestCapturedProcessExcludesStderr(t *testing.T) {
	t.Setenv("DRIFTVERK_TEST_HELPER", "1")
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	a := newApp(context.Background(), strings.NewReader(""), &bytes.Buffer{}, &bytes.Buffer{})
	got, err := a.run(a.ctx, true, exe, "-test.run=TestProcessHelper")
	if err != nil || got != "branch-data\n" {
		t.Fatal(got, err)
	}
}
func TestSetupCreatesWorkspaceAndReusesRegisteredKey(t *testing.T) {
	fx := newFixture(t, "")
	fx.app.setupOverride = nil
	path, _ := identityPath()
	if err := writePrivate(path, []byte("private fixture")); err != nil {
		t.Fatal(err)
	}
	public := "ssh-ed25519 " + base64.StdEncoding.EncodeToString([]byte("fixture key"))
	fp, _ := fingerprint(public)
	fx.app.run = func(context.Context, bool, string, ...string) (string, error) { return public, nil }
	fx.override = func(path string, data object) (any, int, bool) {
		switch path {
		case "/api/auth/organization/list":
			return []object{}, 200, true
		case "/api/auth/organization/create":
			return object{"id": "personal"}, 200, true
		case "/api/ssh-keys":
			if data != nil {
				t.Error("registered duplicate key")
			}
			return object{"keys": []object{{"fingerprint": fp}}}, 200, true
		}
		return nil, 0, false
	}
	if err := fx.app.ensureSetup(true); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, c := range fx.calls {
		if c.path == "/api/auth/organization/create" {
			found = true
			if c.data["name"] != "Test's workspace" || !strings.HasPrefix(str(c.data, "slug"), "personal-") {
				t.Fatal(c.data)
			}
		}
	}
	if !found {
		t.Fatal("personal workspace not created")
	}
}
func TestConnectEditorAndShellChoices(t *testing.T) {
	for _, answer := range []string{"3\n", "2\n"} {
		t.Run(strings.TrimSpace(answer), func(t *testing.T) {
			fx := newFixture(t, answer)
			fx.app.interactive = true
			launched := false
			fx.app.run = func(_ context.Context, _ bool, name string, args ...string) (string, error) {
				launched = true
				if name != "ssh" || strings.Join(args, " ") != "-tt driftverk-workspace.api" {
					t.Fatal(name, args)
				}
				return "", nil
			}
			if err := fx.app.execute([]string{"connect", "api"}); err != nil {
				t.Fatal(err)
			}
			if launched != (answer == "2\n") {
				t.Fatal("unexpected SSH launch")
			}
		})
	}
}

func TestRealOpenSSHKeyAndConfig(t *testing.T) {
	if _, err := exec.LookPath("ssh-keygen"); err != nil {
		t.Skip("OpenSSH client not installed")
	}
	if _, err := exec.LookPath("ssh"); err != nil {
		t.Skip("OpenSSH client not installed")
	}
	fx := newFixture(t, "")
	fx.app.run = newApp(context.Background(), strings.NewReader(""), fx.output, fx.output).run
	if err := fx.app.ensureKey(); err != nil {
		t.Fatal(err)
	}
	key, _ := identityPath()
	before, err := os.ReadFile(key)
	if err != nil {
		t.Fatal(err)
	}
	if err := fx.app.ensureKey(); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(key)
	if !bytes.Equal(before, after) {
		t.Fatal("key changed")
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(key)
		if info.Mode().Perm() != 0600 {
			t.Fatal("private key permissions", info.Mode())
		}
	}
	home, _ := os.UserHomeDir()
	config := filepath.Join(home, ".ssh", "config")
	existing := "Host personal\n  HostName example.test\nHost *\n  User other\n  Port 22\n"
	if err := writePrivate(config, []byte(existing)); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.app.sshConfig("api", true); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ alias, user, host, port string }{{"driftverk-workspace.api", "workspace.api", "ssh.app.driftverk.com", "2222"}, {"personal", "other", "example.test", "22"}} {
		out, err := exec.Command("ssh", "-G", "-F", config, tc.alias).Output()
		if err != nil {
			t.Fatal(err)
		}
		for _, want := range []string{"user " + tc.user, "hostname " + tc.host, "port " + tc.port} {
			if !strings.Contains(string(out), want) {
				t.Fatalf("missing %s", want)
			}
		}
	}
	backups, _ := filepath.Glob(filepath.Join(home, ".ssh", "config.driftverk-backup-*"))
	if len(backups) != 1 {
		t.Fatal("missing backup")
	}
	b, _ := os.ReadFile(backups[0])
	if string(b) != existing {
		t.Fatal("backup changed")
	}
}
func TestCostAcceptsDatabaseNumericStrings(t *testing.T) {
	fx := newFixture(t, "")
	fx.override = func(path string, _ object) (any, int, bool) {
		if path == "/api/billing" {
			return object{"balance_ore": "12345", "hourly_ore": "12.34", "currency": "sek"}, 200, true
		}
		return nil, 0, false
	}
	if err := fx.app.execute([]string{"cost"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(fx.output.String(), "123.45 SEK") || !strings.Contains(fx.output.String(), "0.1234 SEK/hour") {
		t.Fatal(fx.output.String())
	}
}
func TestExistingAgentLoginStartsPersistentSession(t *testing.T) {
	fx := newFixture(t, "1\n\n")
	fx.app.interactive = true
	var commands []string
	fx.app.run = func(_ context.Context, _ bool, _ string, args ...string) (string, error) {
		commands = append(commands, args[len(args)-1])
		return "", nil
	}
	if err := fx.app.connect("api", true); err != nil {
		t.Fatal(err)
	}
	if len(commands) != 3 || commands[1] != "codex login status" || !strings.Contains(commands[2], "tmux -L driftverk-codex new-session -A") {
		t.Fatal(commands)
	}
}
func TestAgentLoginBrowserAllowlist(t *testing.T) {
	for _, tc := range []struct {
		url  string
		want bool
	}{{"https://auth.openai.com/codex/device", true}, {"https://evil.test/codex/device", false}, {"https://auth.openai.com/codex/device/evil", false}, {"https://auth.openai.com.evil.test/codex/device", false}} {
		if deviceURL.MatchString(tc.url) != tc.want {
			t.Fatal(tc.url)
		}
	}
}
