package main

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"
)

var githubRemote = regexp.MustCompile(`^(?:git@github\.com:|ssh://git@github\.com/|https?://github\.com/)([^/\s]+/[^/\s]+?)(?:\.git)?/?$`)

func (a *app) repository() string {
	ctx, cancel := context.WithTimeout(a.ctx, 3*time.Second)
	defer cancel()
	out, err := a.run(ctx, true, "git", "remote", "get-url", "origin")
	if err != nil {
		return ""
	}
	match := githubRemote.FindStringSubmatch(strings.TrimSpace(out))
	if len(match) == 0 {
		return ""
	}
	return match[1]
}
func (a *app) git(args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(a.ctx, 15*time.Second)
	defer cancel()
	// Disable terminal and credential-helper prompting for branch inspection.
	return a.run(ctx, true, "git", append([]string{"-c", "credential.interactive=false", "-c", "core.askPass="}, args...)...)
}
func (a *app) localBranch() (string, bool, error) {
	branch, err := a.git("symbolic-ref", "--quiet", "--short", "HEAD")
	branch = strings.TrimSpace(branch)
	if err != nil || branch == "" {
		return "", false, errors.New("detached HEAD or unavailable Git branch. Choose a remote branch with --branch")
	}
	remote, err := a.git("ls-remote", "--heads", "origin", "refs/heads/"+branch)
	if err != nil {
		return "", false, errors.New("could not check the branch on origin. Check Git access or choose --branch explicitly")
	}
	dirty, err := a.git("status", "--porcelain")
	if err == nil && strings.TrimSpace(dirty) != "" {
		a.print("Local changes and untracked files will not be uploaded.")
	}
	if strings.TrimSpace(remote) == "" {
		return branch, false, nil
	}
	head, err := a.git("rev-parse", "HEAD")
	if err == nil && strings.TrimSpace(head) != strings.Fields(remote)[0] {
		a.print("Local HEAD differs from origin. The environment will use the remote version.")
	}
	return branch, true, nil
}
