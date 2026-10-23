// pcline: for every function of the enclave.host packages in a Go binary, the declaration line its pclntab states,
// compared with the declaration line in each candidate source tree. Read-only; standard library only.
//
//	pcline <binary> <tree>...   (tree = a directory holding isolation/{m2,m3,contract})
package main

import (
	"debug/elf"
	"debug/gosym"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// mainDir: the binary's own package "main" (pcline -main isolation/m3/monitor ...)
var mainDir string

func dirOf(pkg string) (string, bool) {
	if pkg == "main" && mainDir != "" {
		return mainDir, true
	}
	for _, p := range []string{"enclave.host/isolation/m2", "enclave.host/isolation/m3", "enclave.host/isolation/contract"} {
		if pkg == p || strings.HasPrefix(pkg, p+"/") {
			return "isolation/" + strings.TrimPrefix(pkg, "enclave.host/isolation/"), true
		}
	}
	return "", false
}

// decls: "pkgpath.Func" or "pkgpath.(*T).M" / "pkgpath.T.M" -> line, from the non-test files of the package dir.
func decls(tree, pkg string, cache map[string]map[string]int) map[string]int {
	if m, ok := cache[pkg]; ok {
		return m
	}
	m := map[string]int{}
	cache[pkg] = m
	dir, _ := dirOf(pkg)
	fs := token.NewFileSet()
	files, _ := filepath.Glob(filepath.Join(tree, dir, "*.go"))
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		af, err := parser.ParseFile(fs, f, nil, parser.SkipObjectResolution)
		if err != nil {
			continue
		}
		for _, d := range af.Decls {
			fd, ok := d.(*ast.FuncDecl)
			if !ok {
				continue
			}
			name := fd.Name.Name
			if fd.Recv != nil && len(fd.Recv.List) == 1 {
				t := fd.Recv.List[0].Type
				ptr := false
				if s, ok := t.(*ast.StarExpr); ok {
					ptr, t = true, s.X
				}
				if ix, ok := t.(*ast.IndexExpr); ok {
					t = ix.X
				}
				id, ok := t.(*ast.Ident)
				if !ok {
					continue
				}
				if ptr {
					name = "(*" + id.Name + ")." + name
				} else {
					name = id.Name + "." + name
				}
			}
			key := pkg + "." + name
			if name == "init" {
				continue // several per package
			}
			m[key] = fs.Position(fd.Pos()).Line
		}
	}
	return m
}

func main() {
	args := os.Args[1:]
	if len(args) > 2 && args[0] == "-main" {
		mainDir, args = args[1], args[2:]
	}
	f, err := elf.Open(args[0])
	if err != nil {
		panic(err)
	}
	pcln := f.Section(".gopclntab")
	text := f.Section(".text")
	if pcln == nil || text == nil {
		panic("no .gopclntab/.text")
	}
	data, _ := pcln.Data()
	tab, err := gosym.NewTable(nil, gosym.NewLineTable(data, text.Addr))
	if err != nil {
		panic(err)
	}
	type fn struct {
		pkg, key string
		line     int
	}
	var fns []fn
	for _, s := range tab.Funcs {
		pkg := s.PackageName()
		if _, ok := dirOf(pkg); !ok {
			continue
		}
		name := strings.TrimPrefix(s.Name, pkg+".")
		if strings.Contains(name, ".func") || strings.Contains(name, "[") || strings.Contains(name, "wrap") || strings.HasPrefix(name, "init") {
			continue
		}
		_, line, _ := tab.PCToLine(s.Entry)
		fns = append(fns, fn{pkg, pkg + "." + name, line})
	}
	sort.Slice(fns, func(i, j int) bool { return fns[i].key < fns[j].key })
	fmt.Printf("binary %s: %d enclave.host functions\n", os.Args[1], len(fns))
	for _, tree := range args[1:] {
		cache := map[string]map[string]int{}
		match, mismatch, missing := 0, 0, 0
		var bad []string
		for _, x := range fns {
			want, ok := decls(tree, x.pkg, cache)[x.key]
			switch {
			case !ok:
				missing++
				bad = append(bad, "missing "+x.key)
			case want == x.line:
				match++
			default:
				mismatch++
				bad = append(bad, fmt.Sprintf("line %s binary %d tree %d", x.key, x.line, want))
			}
		}
		fmt.Printf("  tree %s: match %d mismatch %d missing %d\n", filepath.Base(tree), match, mismatch, missing)
		for i, b := range bad {
			if i == 8 {
				fmt.Printf("    ... %d more\n", len(bad)-8)
				break
			}
			fmt.Println("    " + b)
		}
	}
}
