package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/zalando/go-keyring"
)

type apiError struct {
	Message, Code string
	Status        int
}

func (e *apiError) Error() string { return fmt.Sprintf("%s (HTTP %d)", e.Message, e.Status) }

type client struct {
	ctx                           context.Context
	origin, token, dir, tokenPath string
	http                          *http.Client
	getSecret                     func(string, string) (string, error)
	setSecret                     func(string, string, string) error
	deleteSecret                  func(string, string) error
}

func configDir() (string, error) {
	if x := os.Getenv("XDG_CONFIG_HOME"); x != "" {
		return filepath.Join(x, "driftverk"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	legacy := filepath.Join(home, ".config", "driftverk")
	return platformConfigDir(legacy)
}
func validOrigin(origin string) error {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return errors.New("invalid control-plane origin")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1")) {
		return errors.New("the control plane must use HTTPS (except localhost)")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || u.Opaque != "" {
		return errors.New("use a control-plane origin without a path or credentials")
	}
	return nil
}
func newClient(ctx context.Context) (*client, error) {
	origin := strings.TrimRight(env("DRIFTVERK_CONTROL_PLANE_URL", "https://app.driftverk.com"), "/")
	if err := validOrigin(origin); err != nil {
		return nil, err
	}
	dir, err := configDir()
	if err != nil {
		return nil, err
	}
	if err = privateDir(dir); err != nil {
		return nil, err
	}
	sum := sha256.Sum256([]byte(origin))
	c := &client{ctx: ctx, origin: origin, dir: dir, tokenPath: filepath.Join(dir, fmt.Sprintf("%x.token", sum[:8])), getSecret: keyring.Get, setSecret: keyring.Set, deleteSecret: keyring.Delete,
		http: &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("unexpected redirect from the control plane")
		}}}
	if err := c.loadToken(); err != nil {
		return nil, err
	}

	return c, nil
}

// A fallback file is authoritative, including the empty logout marker. Successful
// keyring writes remove it, so a stale keyring entry cannot shadow a newer login.
func (c *client) loadToken() error {
	if _, err := os.Stat(c.tokenPath); err == nil {
		if err := protect(c.tokenPath, false); err != nil {
			return err
		}
		b, err := os.ReadFile(c.tokenPath)
		if err != nil {
			return err
		}
		c.token = strings.TrimSpace(string(b))
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	c.token, _ = c.getSecret("driftverk-cli", c.origin)
	if c.token == "" {
		c.token, _ = legacySecret(c.origin)
	}
	return nil
}

func (c *client) request(path string, data object) (any, error) {
	var body io.Reader
	method := "GET"
	if data != nil {
		b, err := json.Marshal(data)
		if err != nil {
			return nil, err
		}
		body = bytes.NewReader(b)
		method = "POST"
	}
	req, err := http.NewRequestWithContext(c.ctx, method, c.origin+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", c.origin)
	req.Header.Set("User-Agent", "Driftverk-CLI/"+version)
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var result any
	decodeErr := json.NewDecoder(io.LimitReader(res.Body, 16<<20)).Decode(&result)
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		m, _ := result.(map[string]any)
		return nil, &apiError{fallback(str(m, "error_description"), fallback(str(m, "message"), fallback(str(m, "error"), "Request failed"))), str(m, "error"), res.StatusCode}
	}
	if decodeErr != nil {
		return nil, fmt.Errorf("invalid API response: %w", decodeErr)
	}
	return result, nil
}
func (c *client) get(path string, data object) (object, error) {
	v, err := c.request(path, data)
	if err != nil {
		return nil, err
	}
	if v == nil {
		return nil, nil
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, errors.New("unexpected API response")
	}
	return m, nil
}
func (c *client) organizations() ([]object, error) {
	v, err := c.request("/api/auth/organization/list", nil)
	if err != nil {
		return nil, err
	}
	var result []object
	for _, item := range array(v) {
		m, ok := item.(map[string]any)
		if !ok {
			return nil, errors.New("invalid organization response")
		}
		result = append(result, m)
	}
	return result, nil
}
func (c *client) saveToken(token string) error {
	if token == "" {
		return errors.New("login response did not include a token")
	}
	if err := c.setSecret("driftverk-cli", c.origin, token); err == nil {
		if err = os.Remove(c.tokenPath); err != nil && !os.IsNotExist(err) {
			return err
		}
	} else if err = writePrivate(c.tokenPath, []byte(token)); err != nil {
		return err
	}
	c.token = token
	return nil
}
func (c *client) clearToken() error {
	err := c.deleteSecret("driftverk-cli", c.origin)
	if err != nil && !errors.Is(err, keyring.ErrNotFound) {
		// Keep an empty marker when the store is unavailable. It prevents an
		// older credential from reappearing if the store becomes available later.
		if err := writePrivate(c.tokenPath, nil); err != nil {
			return err
		}
	} else if err := os.Remove(c.tokenPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := removeLegacySecret(c.origin); err != nil {
		return err
	}
	c.token = ""
	return nil
}

func privateDir(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	return protect(path, true)
}
func writePrivate(path string, data []byte) error {
	if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return errors.New("refusing to replace a symlink: " + path)
	}
	if err := privateDir(filepath.Dir(path)); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".driftverk-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = protect(f.Name(), false); err != nil {
		f.Close()
		return err
	}
	_, err = f.Write(data)
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), path)
}
