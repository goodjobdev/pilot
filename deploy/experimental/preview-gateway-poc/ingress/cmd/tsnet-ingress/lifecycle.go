package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
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
