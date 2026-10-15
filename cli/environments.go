package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

func randomSuffix(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func validName(name string) error {
	if !namePattern.MatchString(name) {
		return errors.New("use lowercase letters, numbers and hyphens for the environment name")
	}
	return nil
}
func validPort(port int) error {
	if port < 1 || port > 65535 {
		return errors.New("port must be between 1 and 65535")
	}
	return nil
}
func selectEnvironment(list object, name string) (object, error) {
	var matches []object
	for _, row := range rows(list, "environments") {
		if name == str(row, "name") || name == str(row, "id") {
			matches = append(matches, row)
		}
	}
	if len(matches) != 1 {
		return nil, errors.New("environment not found in the active organization. Run driftverk org or driftverk ls")
	}
	return matches[0], nil
}
func (a *app) waitEnvironment(id, name string, timeout time.Duration) (object, error) {
	started := time.Now()
	deadline := started.Add(timeout)
	last := ""
	for time.Now().Before(deadline) {
		data, err := a.client.get("/api/environments/"+url.PathEscape(id), nil)
		if err != nil {
			return nil, err
		}
		environment := obj(data, "environment")
		application := obj(environment, "application_status")
		if str(application, "status") == "failed" {
			return nil, fmt.Errorf("%s Run driftverk logs %s for details", fallback(str(application, "message"), "Application startup failed."), name)
		}
		if str(environment, "state") == "running" && environment["active_operation"] == nil && str(application, "status") != "starting" {
			a.print("✓ Ready in %ds", int(time.Since(started).Seconds()))
			return environment, nil
		}
		if str(environment, "state") == "degraded" {
			return nil, fmt.Errorf("%s Run driftverk logs %s for details", fallback(str(environment, "error_message"), "Environment setup failed."), name)
		}
		step := fallback(str(environment, "provisioning_step"), str(environment, "state"))
		if step != last {
			a.print("… %s", strings.ReplaceAll(step, "-", " "))
			last = step
		}
		if err := a.sleep(2 * time.Second); err != nil {
			return nil, err
		}
	}
	return nil, fmt.Errorf("environment is still starting. Check it with driftverk logs %s", name)
}

func (a *app) printEnvironmentNextSteps(name string, environment object) {
	a.print("\nConnect: driftverk ssh %s", name)
	a.print("Editor SSH setup: driftverk ssh-config %s", name)
	if port := number(environment, "preview_port"); port > 0 {
		a.print("Preview: driftverk preview %s --port %.0f", name, port)
	}
}

func (a *app) create(args []string) error {
	f := a.flags("create")
	repository := f.String("repository", "", "GitHub owner/repository")
	image := f.String("image", "", "Container image")
	empty := f.Bool("empty", false, "Use an image without cloning a repository")
	example := f.Bool("example", false, "Start the example app")
	yes := f.BoolP("yes", "y", false, "Accept the creation summary")
	snapshot := f.String("snapshot", "", "Snapshot ID")
	branch := f.String("branch", "", "Remote branch to clone")
	startup := f.String("startup-command", "", "Override the startup command")
	port := f.Int("port", 0, "Application preview port")
	noBrowser := f.Bool("no-browser", false, "Print login URLs without opening a browser")
	noConnect := f.Bool("no-connect", false, "Skip interactive agent setup")
	if err := arguments(f, args, 0, 1); err != nil {
		return err
	}
	sources := 0
	for _, flag := range []string{"repository", "empty", "example", "snapshot"} {
		if f.Changed(flag) {
			sources++
		}
	}
	if sources > 1 {
		return errors.New("choose only one of --repository, --empty, --example or --snapshot")
	}
	if *image != "" && (*snapshot != "" || *example) {
		return errors.New("--image cannot be combined with --snapshot or --example")
	}
	detected := ""
	if sources == 0 && *image == "" {
		detected = a.repository()
		if detected != "" {
			*repository = detected
			a.print("Repository: %s", detected)
		}
	}
	if *branch != "" && *repository == "" {
		return errors.New("--branch requires an explicit or detected repository")
	}
	if detected != "" && *branch == "" {
		local, exists, err := a.localBranch()
		if err != nil {
			return err
		}
		if exists {
			*branch = local
		} else if a.interactive && !*yes {
			a.print("Branch %s is not on origin.", local)
			*branch, err = a.ask("Remote branch to clone, or Enter to cancel")
			if err != nil {
				return err
			}
			if *branch == "" {
				a.print("Creation cancelled. No environment was created.")
				return nil
			}
		} else {
			return fmt.Errorf("branch %s is not on origin. Push it or choose --branch explicitly", local)
		}
	}
	if *repository == "" && *image == "" && *snapshot == "" && !*empty && !*example {
		if !a.interactive {
			return errors.New("no GitHub repository detected. Choose --empty, --example, --repository, --image or --snapshot")
		}
		choice, err := a.ask("No GitHub repository detected. Create [1] empty environment or [2] example app? [1]")
		if err != nil {
			return err
		}
		if choice != "" && choice != "1" && choice != "2" {
			return errors.New("choose 1 or 2")
		}
		*empty = choice != "2"
		*example = choice == "2"
	}
	name := f.Arg(0)
	if name == "" && *repository != "" {
		parts := strings.Split(*repository, "/")
		name = strings.Trim(slugChars.ReplaceAllString(strings.ToLower(parts[len(parts)-1]), "-"), "-")
		if len(name) > 63 {
			name = strings.TrimRight(name[:63], "-")
		}
	}
	if name == "" {
		prefix := "dev-"
		if *example {
			prefix = "example-"
		}
		name = prefix + randomSuffix(4)
	}
	if err := validName(name); err != nil {
		return err
	}
	if f.Changed("port") {
		if err := validPort(*port); err != nil {
			return err
		}
	}
	if err := a.ensureSetup(*noBrowser); err != nil {
		return err
	}
	listing, err := a.client.get("/api/environments", nil)
	if err != nil {
		return err
	}
	var member object
	if str(obj(listing, "workspace"), "role") == "member" {
		member, err = a.client.get("/api/member-environment-settings", nil)
		if err != nil {
			return err
		}
		if member["enabled"] != true {
			return errors.New("member environment creation is disabled. Ask a workspace admin")
		}
		if existing := obj(member, "existing"); existing != nil {
			return fmt.Errorf("you already have a personal environment: %s", str(existing, "name"))
		}
		if *example || *snapshot != "" {
			return errors.New("members can create a Driftverk Dev environment. Use --empty or a repository")
		}
	}
	for _, row := range rows(listing, "environments") {
		if str(row, "name") == name {
			return fmt.Errorf("environment %s already exists. Use driftverk connect %s or choose another name", name, name)
		}
	}
	payload := object{"name": name}
	defaultImage := ""
	switch {
	case *example:
		config, err := a.client.get("/api/cli/config", nil)
		if err != nil {
			return err
		}
		exampleConfig := obj(config, "example")
		if exampleConfig == nil {
			return errors.New("example configuration is unavailable")
		}
		for key, v := range exampleConfig {
			payload[key] = v
		}
		payload["name"] = name
		a.print("Starting the example app.")
	case *snapshot != "":
		payload["source_type"] = "snapshot"
		payload["snapshot_id"] = *snapshot
	default:
		config, err := a.client.get("/api/config", nil)
		if err != nil {
			return err
		}
		defaultImage = str(config, "defaultImage")
		payload["source_type"] = "image"
		payload["image"] = fallback(*image, defaultImage)
		if member != nil {
			if *image != "" && *image != str(member, "image") {
				return errors.New("members must use Driftverk Dev. Omit --image or use --empty")
			}
			for _, key := range []string{"image", "cpu", "memory_mb"} {
				payload[key] = member[key]
			}
		}
		if *repository != "" {
			payload["repository"] = *repository
			if *branch != "" {
				payload["repository_branch"] = *branch
			}
		}
	}
	if *startup != "" {
		payload["startup_command"] = *startup
	}
	if f.Changed("port") {
		payload["preview_port"] = *port
	}
	session, err := a.client.get("/api/auth/get-session", nil)
	if err != nil {
		return err
	}
	organizations, err := a.client.organizations()
	if err != nil {
		return err
	}
	selected := "not selected"
	for _, item := range organizations {
		if str(item, "id") == str(obj(session, "session"), "activeOrganizationId") {
			selected = str(item, "name")
		}
	}
	a.print("\nOrganization: %s", selected)
	a.print("Environment: %s", name)
	if *snapshot != "" {
		a.print("Snapshot: %s", *snapshot)
	} else {
		imageName := str(payload, "image")
		if *example {
			imageName = "Example app"
		} else if imageName == defaultImage || member != nil {
			imageName = "Driftverk Dev"
		}
		a.print("Image: %s", imageName)
		if member != nil {
			a.print("Size: %g vCPU, %g GB memory, 40 GB disk", number(payload, "cpu"), number(payload, "memory_mb")/1024)
			a.print("Your workspace pays for usage. One personal environment per member.")
		}
		repoLabel := fallback(*repository, "none")
		if *example {
			repoLabel = "example app"
		}
		a.print("Repository: %s", repoLabel)
		if *repository != "" {
			a.print("Branch: %s", fallback(*branch, "repository default"))
			a.print("Cloned from GitHub. Local files and unpushed changes will not be uploaded.")
		}
	}
	if !*yes {
		if !a.interactive {
			return errors.New("use --yes to accept this summary in a noninteractive terminal")
		}
		answer, err := a.ask("Create environment? [Y/n]")
		if err != nil {
			return err
		}
		if answer != "" && strings.ToLower(answer) != "y" && strings.ToLower(answer) != "yes" {
			a.print("Creation cancelled. No environment was created.")
			return nil
		}
	}
	result, err := a.client.get("/api/environments", payload)
	if err != nil {
		var api *apiError
		if !errors.As(err, &api) {
			a.print("Creation response interrupted. Run driftverk ls before retrying; the environment may already exist.")
		}
		return err
	}
	a.print("✓ Environment created: %s", name)
	ready, err := a.waitEnvironment(str(result, "id"), name, 15*time.Minute)
	if err != nil {
		a.print("Environment %s still exists. Check driftverk ls and driftverk logs %s.", name, name)
		a.print("When ready: driftverk connect %s. To remove it: driftverk delete %s", name, name)
		return err
	}
	if a.interactive && !*noConnect && !*yes {
		answer, askErr := a.ask("Set up SSH for editors? [Y/n]")
		if askErr != nil {
			return askErr
		}
		answer = strings.ToLower(answer)
		if answer == "" || answer == "y" || answer == "yes" {
			_, err = a.sshConfig(name, *noBrowser)
			if err == nil {
				if port := number(ready, "preview_port"); port > 0 {
					a.print("Preview: driftverk preview %s --port %.0f", name, port)
				}
			}
			return err
		}
	}
	a.printEnvironmentNextSteps(name, ready)
	a.print("Continue setup: driftverk connect %s", name)
	return nil
}
func (a *app) environmentCommand(command string, args []string) error {
	f := a.flags(command)
	var port *int
	if command == "preview" {
		port = f.Int("port", 0, "Application preview port")
	}
	count := 1
	if command == "ls" || command == "whoami" || command == "cost" {
		count = 0
	} else if command == "fork" {
		count = 2
	}
	if err := arguments(f, args, count, count); err != nil {
		return err
	}
	if command == "cost" {
		billing, err := a.client.get("/api/billing", nil)
		if err != nil {
			return err
		}
		currency := strings.ToUpper(str(billing, "currency"))
		if billing["complimentary"] == true {
			a.print("Complimentary account")
		} else if str(billing, "hosting_mode") == "hybrid" {
			a.print("Hybrid subscription: %s", str(billing, "subscription_status"))
		} else {
			a.print("Balance: %.2f %s", number(billing, "balance_ore")/100, currency)
			a.print("Current usage: %.4f %s/hour", number(billing, "hourly_ore")/100, currency)
		}
		a.print("Stopped environments can still incur storage charges.")
		return nil
	}
	if command == "whoami" {
		session, err := a.client.get("/api/auth/get-session", nil)
		if err != nil {
			return err
		}
		if session == nil {
			return errors.New("not signed in. Run driftverk login")
		}
		organizations, err := a.client.organizations()
		if err != nil {
			return err
		}
		selected := "not selected; run driftverk org"
		for _, item := range organizations {
			if str(item, "id") == str(obj(session, "session"), "activeOrganizationId") {
				selected = str(item, "name")
			}
		}
		a.print("%s", str(obj(session, "user"), "email"))
		a.print("Organization: %s", selected)
		return nil
	}
	listing, err := a.client.get("/api/environments", nil)
	if err != nil {
		return err
	}
	if command == "ls" {
		a.print("NAME\tSTATE\tSTEP")
		for _, row := range rows(listing, "environments") {
			a.print("%s\t%s\t%s", str(row, "name"), str(row, "state"), str(row, "provisioning_step"))
		}
		return nil
	}
	environment, err := selectEnvironment(listing, f.Arg(0))
	if err != nil {
		return err
	}
	path := "/api/environments/" + url.PathEscape(str(environment, "id"))
	switch command {
	case "fork":
		name := f.Arg(1)
		if err = validName(name); err != nil {
			return err
		}
		for _, row := range rows(listing, "environments") {
			if str(row, "name") == name {
				return errors.New("an environment with that name already exists")
			}
		}
		snapshot, err := a.client.get("/api/snapshots", object{"environment_id": environment["id"], "name": "fork-" + randomSuffix(6)})
		if err != nil {
			return err
		}
		a.print("Capturing snapshot…")
		deadline := time.Now().Add(15 * time.Minute)
		for time.Now().Before(deadline) {
			data, err := a.client.get("/api/snapshots", nil)
			if err != nil {
				return err
			}
			for _, captured := range rows(data, "snapshots") {
				if captured["id"] != snapshot["id"] {
					continue
				}
				switch str(captured, "status") {
				case "ready":
					result, err := a.client.get("/api/environments", object{"name": name, "source_type": "snapshot", "snapshot_id": snapshot["id"]})
					if err != nil {
						return err
					}
					a.print("Snapshot retained: %s", str(snapshot, "id"))
					ready, waitErr := a.waitEnvironment(str(result, "id"), name, 15*time.Minute)
					if waitErr == nil {
						a.printEnvironmentNextSteps(name, ready)
					}
					return waitErr
				case "building", "queued":
				default:
					return errors.New(fallback(str(captured, "error_message"), "Snapshot failed."))
				}
			}
			if err = a.sleep(2 * time.Second); err != nil {
				return err
			}
		}
		return errors.New("snapshot is still building. Check Snapshots in the dashboard before retrying")
	case "logs":
		data, err := a.client.get(path+"/telemetry", nil)
		if err != nil {
			return err
		}
		logs := rows(data, "logs")
		for _, entry := range logs {
			a.print("%s %s %s", str(entry, "recorded_at"), str(entry, "severity"), str(entry, "message"))
		}
		if len(logs) == 0 {
			a.print("No logs available yet. State: %s", str(environment, "state"))
		}
		return nil
	case "preview":
		if !f.Changed("port") {
			*port = int(number(environment, "preview_port"))
		}
		if *port == 0 {
			return errors.New("specify the application port with --port 3000")
		}
		if err = validPort(*port); err != nil {
			return err
		}
		result, err := a.client.get(fmt.Sprintf("%s/ports/%d/preview", path, *port), object{})
		if err != nil {
			return err
		}
		a.print("%s", str(result, "url"))
		a.print("Anyone with this link can access it until %s", str(result, "expires_at"))
		return nil
	default:
		if command == "delete" {
			answer, err := a.ask("Permanently delete " + str(environment, "name") + "? Type its name")
			if err != nil {
				return err
			}
			if answer != str(environment, "name") {
				a.print("Deletion cancelled.")
				return nil
			}
		}
		if _, err = a.client.request(path+"/actions", object{"action": command}); err != nil {
			return err
		}
		a.print("%s queued: %s", command, str(environment, "name"))
		return nil
	}
}
