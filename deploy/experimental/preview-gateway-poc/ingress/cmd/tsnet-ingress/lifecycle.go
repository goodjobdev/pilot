package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// serveHTTPS owns the HTTP listener lifecycle. Shutdown drains ordinary HTTP
// requests; closing the tsnet node afterwards also tears down hijacked upgrades
// that net/http deliberately does not manage.
func serveHTTPS(ctx context.Context, server *http.Server, listener net.Listener, timeout time.Duration, closeNode func() error) error {
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(listener) }()

	closeNodeAndReport := func() {
		if err := closeNode(); err != nil {
			log.Printf("tsnet close failed during ingress shutdown: %v", err)
		}
	}
	unexpectedServeError := func(err error) error {
		if err == nil || errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}

	select {
	case err := <-serveDone:
		closeNodeAndReport()
		return unexpectedServeError(err)
	case <-ctx.Done():
		log.Printf("shutdown requested; draining active HTTPS connections")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("HTTPS graceful shutdown timed out: %v", err)
			_ = server.Close()
		}
		// Shutdown does not wait for hijacked WebSocket connections. Closing
		// the independent tsnet node is the transport-level termination step.
		closeNodeAndReport()
		return unexpectedServeError(<-serveDone)
	}
}

// readyLine is the readiness contract the Node supervisor waits for. It is
// emitted only after every listener exists, so "ready" truthfully means all
// preview ports are bound.
const readyLine = "tsnet HTTPS ingress ready"

// serveAll runs one HTTP server per listener and shares a single node close.
// The node is closed only after the last listener has finished draining, so a
// draining WebSocket on one port is not cut short by another port exiting.
func serveAll(ctx context.Context, servers []*http.Server, listeners []net.Listener, timeout time.Duration, closeNode func() error) error {
	if len(servers) != len(listeners) || len(servers) == 0 {
		return errors.New("listener set is empty or mismatched")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var remaining int32 = int32(len(servers))
	var once sync.Once
	lastDone := func() error {
		if atomic.AddInt32(&remaining, -1) == 0 {
			once.Do(func() {
				if err := closeNode(); err != nil {
					log.Printf("tsnet close failed during ingress shutdown: %v", err)
				}
			})
		}
		return nil
	}
	errs := make(chan error, len(servers))
	for index := range servers {
		go func(server *http.Server, listener net.Listener) {
			errs <- serveHTTPS(ctx, server, listener, timeout, lastDone)
		}(servers[index], listeners[index])
	}
	var first error
	failed := false
	for range servers {
		if err := <-errs; err != nil {
			if first == nil {
				first = err
			}
			if !failed {
				failed = true
				cancel()
			}
		}
	}
	return first
}
