package main

import (
	"context"

	"github.com/kandev/kandev/pkg/pluginsdk"
)

func main() {
	p := &githubStatusPlugin{}
	p.state = newHostState(p.Host)
	p.poller = newPoller(enabledSources(), p.state, p.emitTransition)

	// The poller runs for the life of the subprocess. kandev supervises that
	// lifetime, so there is nothing to stop on: when the process goes away the
	// goroutine goes with it. The context exists so Run's shape stays honest
	// and testable.
	ctx := context.Background()
	go p.poller.Run(ctx)

	pluginsdk.Serve(p)
}
