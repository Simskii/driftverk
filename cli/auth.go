package main

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var namePattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
var slugChars = regexp.MustCompile(`[^a-z0-9]+`)

func (a *app) login(noBrowser bool) error {
	code, err := a.client.get("/api/auth/device/code", object{"client_id": "driftverk-cli"})
	if err != nil {
		return err
	}
	link := fallback(str(code, "verification_uri_complete"), str(code, "verification_uri"))
	u, err := url.Parse(link)
	if err != nil || u.Scheme+"://"+u.Host != a.client.origin || u.User != nil {
		return errors.New("unexpected login URL from the control plane")
	}
	a.print("Open %s", link)
	a.print("Confirm this code: %s", str(code, "user_code"))
	if !noBrowser {
		_ = a.open(link)
	}
	expires := min(number(code, "expires_in"), 600)
	interval := time.Duration(max(number(code, "interval"), 5)) * time.Second
	deadline := time.Now().Add(time.Duration(expires) * time.Second)
	a.print("Waiting for browser approval…")
	for time.Now().Add(interval).Before(deadline) {
		if err := a.sleep(interval); err != nil {
			return err
		}
		token, err := a.client.get("/api/auth/device/token", object{"client_id": "driftverk-cli", "device_code": code["device_code"], "grant_type": "urn:ietf:params:oauth:grant-type:device_code"})
		if err != nil {
			var api *apiError
			if errors.As(err, &api) {
				if api.Code == "authorization_pending" {
					continue
				}
				if api.Code == "slow_down" {
					interval += 5 * time.Second
					continue
				}
			}
			return err
		}
		if err := a.client.saveToken(str(token, "access_token")); err != nil {
			return err
		}
		a.print("Signed in. Continue in your terminal.")
		return nil
	}
	return errors.New("login expired. Run driftverk login again")
}
func (a *app) organization(auto bool) error {
	items, err := a.client.organizations()
	if err != nil {
		return err
	}
	var item object
	if auto && len(items) == 1 {
		item = items[0]
	} else {
		for i, item := range items {
			a.print("%d. %s (%s)", i+1, str(item, "name"), str(item, "slug"))
		}
		choice := ""
		if len(items) > 0 {
			choice, err = a.ask("Organization number, or Enter to create one")
			if err != nil {
				return err
			}
		}
		if choice != "" {
			index, err := strconv.Atoi(choice)
			if err != nil || index < 1 || index > len(items) {
				return errors.New("choose one of the listed numbers")
			}
			item = items[index-1]
		} else {
			name, err := a.ask("Organization name")
			if err != nil {
				return err
			}
			if name == "" {
				return errors.New("organization name is required")
			}
			suggested := strings.Trim(slugChars.ReplaceAllString(strings.ToLower(name), "-"), "-")
			if len(suggested) > 62 {
				suggested = strings.TrimRight(suggested[:62], "-")
			}
			suggested = fallback(suggested, "my-team")
			slug, err := a.ask("Organization slug [" + suggested + "]")
			if err != nil {
				return err
			}
			slug = fallback(slug, suggested)
			if !namePattern.MatchString(slug) {
				return errors.New("use lowercase letters, numbers and hyphens for the slug")
			}
			mode, err := a.ask("Hosting: Cloud or Hybrid? [Cloud]")
			if err != nil {
				return err
			}
			mode = strings.ToLower(fallback(mode, "cloud"))
			if mode != "cloud" && mode != "hybrid" {
				return errors.New("choose Cloud or Hybrid")
			}
			if mode == "cloud" {
				mode = "managed"
			}
			item, err = a.client.get("/api/auth/organization/create", object{"name": name, "slug": slug, "hostingMode": mode})
			if err != nil {
				return err
			}
		}
	}
	if _, err := a.client.request("/api/auth/organization/set-active", object{"organizationId": item["id"]}); err != nil {
		return err
	}
	a.print("Active organization: %s", str(item, "name"))
	return nil
}
func (a *app) ensureSetup(noBrowser bool) error {
	if a.setupOverride != nil {
		return a.setupOverride(noBrowser)
	}
	session, err := a.client.get("/api/auth/get-session", nil)
	if err != nil {
		var api *apiError
		if !errors.As(err, &api) || api.Status != 401 {
			return err
		}
	}
	if session == nil {
		if err = a.login(noBrowser); err != nil {
			return err
		}
		session, err = a.client.get("/api/auth/get-session", nil)
		if err != nil {
			return err
		}
	}
	if session == nil {
		return errors.New("could not restore your session. Run driftverk login")
	}
	items, err := a.client.organizations()
	if err != nil {
		return err
	}
	active := str(obj(session, "session"), "activeOrganizationId")
	found := false
	for _, item := range items {
		if str(item, "id") == active {
			found = true
		}
	}
	if !found {
		if len(items) == 0 {
			user := obj(session, "user")
			name := fallback(str(user, "name"), strings.Split(str(user, "email"), "@")[0]) + "'s workspace"
			sum := sha256.Sum256([]byte(str(user, "id")))
			item, err := a.client.get("/api/auth/organization/create", object{"name": name, "slug": fmt.Sprintf("personal-%x", sum[:10]), "hostingMode": "managed"})
			if err != nil {
				return err
			}
			if _, err = a.client.request("/api/auth/organization/set-active", object{"organizationId": item["id"]}); err != nil {
				return err
			}
			a.print("Created %s", name)
		} else if err = a.organization(true); err != nil {
			return err
		}
	}
	return a.ensureKey()
}
func identityPath() (string, error) {
	dir, err := configDir()
	return filepath.Join(dir, "id_ed25519"), err
}
func fingerprint(public string) (string, error) {
	fields := strings.Fields(public)
	if len(fields) < 2 || strings.ContainsAny(public, "\r\n") || !(fields[0] == "ssh-ed25519" || fields[0] == "ssh-rsa" || strings.HasPrefix(fields[0], "ecdsa-sha2-")) {
		return "", errors.New("select an OpenSSH public key file, never a private key")
	}
	b, err := base64.StdEncoding.DecodeString(fields[1])
	if err != nil || len(b) == 0 {
		return "", errors.New("invalid OpenSSH public key")
	}
	sum := sha256.Sum256(b)
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:]), nil
}
func (a *app) registerKey(public, label string) error {
	fp, err := fingerprint(public)
	if err != nil {
		return err
	}
	data, err := a.client.get("/api/ssh-keys", nil)
	if err != nil {
		return err
	}
	for _, key := range rows(data, "keys") {
		if str(key, "fingerprint") == fp {
			return nil
		}
	}
	if _, err = a.client.request("/api/ssh-keys", object{"name": label, "public_key": public}); err != nil {
		return err
	}
	a.print("SSH key registered.")
	return nil
}
func (a *app) ensureKey() error {
	path, err := identityPath()
	if err != nil {
		return err
	}
	if err = privateDir(filepath.Dir(path)); err != nil {
		return err
	}
	if _, err = os.Stat(path); os.IsNotExist(err) {
		if _, err = os.Stat(path + ".pub"); !os.IsNotExist(err) {
			return errors.New("Driftverk public key exists without its private key: " + path + ".pub")
		}
		if _, err = a.run(a.ctx, false, "ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "driftverk-cli", "-f", path); err != nil {
			return fmt.Errorf("could not generate SSH key; install the OpenSSH client: %w", err)
		}
	} else if err != nil {
		return err
	}
	if err = protect(path, false); err != nil {
		return err
	}
	public, err := a.run(a.ctx, true, "ssh-keygen", "-y", "-P", "", "-f", path)
	if err != nil {
		return fmt.Errorf("could not read Driftverk SSH key: %w", err)
	}
	return a.registerKey(strings.TrimSpace(public), "Driftverk CLI")
}
func (a *app) addKey() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	defaultPath := ""
	for _, name := range []string{"id_ed25519.pub", "id_rsa.pub"} {
		p := filepath.Join(home, ".ssh", name)
		if _, err := os.Stat(p); err == nil {
			defaultPath = p
			break
		}
	}
	path, err := a.ask("Public SSH key file [" + defaultPath + "]")
	if err != nil {
		return err
	}
	path = fallback(path, defaultPath)
	if strings.HasPrefix(path, "~/") {
		path = filepath.Join(home, path[2:])
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	public := strings.TrimSpace(string(b))
	if _, err = fingerprint(public); err != nil {
		return err
	}
	labelDefault := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	label, err := a.ask("Key label [" + labelDefault + "]")
	if err != nil {
		return err
	}
	return a.registerKey(public, fallback(label, labelDefault))
}
