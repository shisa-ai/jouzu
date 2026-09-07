// Modified for deterministic Unicode conformance and bounded native scanning.
// textguard-helper serves bounded deterministic scan evidence over JSON lines.
package main

import (
	"bufio"
	"fmt"
	"os"
	"runtime"
	"runtime/debug"

	"github.com/shisa-ai/textguard-go/internal/bridge"
)

func main() {
	// These reduce idle reservation and collector overhead; they are not hard
	// process-memory limits. The scan API separately bounds input and findings.
	runtime.GOMAXPROCS(1)
	debug.SetMemoryLimit(96 << 20)
	runner, err := bridge.NewProductionRunner()
	if err != nil {
		fmt.Fprintln(os.Stderr, "scanner initialization failed")
		os.Exit(1)
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), bridge.MaxRequestBytes+1)
	writer := bufio.NewWriter(os.Stdout)
	for scanner.Scan() {
		if _, err := writer.Write(runner.Handle(scanner.Bytes())); err != nil {
			os.Exit(1)
		}
		if err := writer.WriteByte('\n'); err != nil {
			os.Exit(1)
		}
		if err := writer.Flush(); err != nil {
			os.Exit(1)
		}
	}
	if scanner.Err() != nil {
		fmt.Fprintln(os.Stderr, "invalid protocol input")
		os.Exit(1)
	}
}
