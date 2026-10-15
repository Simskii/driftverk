// Run in a Go module: go run /path/to/third-party-go.go OUTPUT_FILE
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
)

func main() {
	if err := generate(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func generate() error {
	if len(os.Args) != 2 {
		return fmt.Errorf("expected output file")
	}
	output, err := exec.Command("go", "list", "-m", "-json", "all").Output()
	if err != nil {
		return err
	}
	var text bytes.Buffer
	text.WriteString("Third-party notices\n\nIncludes all modules in the build list and Go runtime terms. Each component retains its own terms.\n")
	appendLegal := func(name, dir string) error {
		files, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		var names []string
		legal := regexp.MustCompile(`(?i)^(licen[sc]e|copying|notice|copyright|authors|patents)([._-].*)?$`)
		for _, file := range files {
			if !file.IsDir() && legal.MatchString(file.Name()) {
				names = append(names, file.Name())
			}
		}
		if len(names) == 0 {
			return fmt.Errorf("missing upstream legal text for %s", name)
		}
		sort.Strings(names)
		fmt.Fprintf(&text, "\n===== %s =====\n", name)
		for _, file := range names {
			data, err := os.ReadFile(filepath.Join(dir, file))
			if err != nil {
				return err
			}
			fmt.Fprintf(&text, "\n--- %s ---\n%s\n", file, data)
		}
		return nil
	}
	if err := appendLegal("Go "+runtime.Version(), runtime.GOROOT()); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(output))
	for {
		var module struct {
			Path, Version, Dir string
			Main               bool
			Replace            *struct{ Dir string }
		}
		if err := decoder.Decode(&module); err == io.EOF {
			break
		} else if err != nil {
			return err
		}
		if module.Main {
			continue
		}
		if module.Replace != nil {
			module.Dir = module.Replace.Dir
		}
		if module.Dir == "" {
			return fmt.Errorf("module %s not downloaded; run go mod download", module.Path)
		}
		if err := appendLegal(module.Path+"@"+module.Version, module.Dir); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(filepath.Dir(os.Args[1]), 0755); err != nil {
		return err
	}
	return os.WriteFile(os.Args[1], text.Bytes(), 0644)
}
