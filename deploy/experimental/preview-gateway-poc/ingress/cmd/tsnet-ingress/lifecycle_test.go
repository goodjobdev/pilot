package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeTsnetListener struct {
	net.Listener
	mu    sync.Mutex
	conns []net.Conn
}

func (l *fakeTsnetListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	l.mu.Lock()
	l.conns = append(l.conns, conn)
	l.mu.Unlock()
	return conn, nil
}

// closeTransport models tsnet.Server.Close: it closes the listener and all
// accepted transport connections, including net/http hijacked WebSockets.
func (l *fakeTsnetListener) closeTransport() error {
	listenerErr := l.Listener.Close()
	l.mu.Lock()
	conns := append([]net.Conn(nil), l.conns...)
	l.mu.Unlock()
	for _, conn := range conns {
		_ = conn.Close()
	}
	return listenerErr
}

func TestServeHTTPSCancellationDrainsHTTPThenClosesHijackedUpgrade(t *testing.T) {
	base, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	listener := &fakeTsnetListener{Listener: base}
	httpStarted := make(chan struct{})
	httpRelease := make(chan struct{})
	wsUpgraded := make(chan struct{})
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/active" {
			close(httpStarted)
			<-httpRelease
			_, _ = io.WriteString(w, "drained")
			return
		}
		conn, rw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
		_ = rw.Flush()
		close(wsUpgraded)
		_, _ = io.Copy(io.Discard, conn)
		_ = conn.Close()
	})}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	nodeClosed := make(chan struct{})
	runDone := make(chan error, 1)
	go func() {
		runDone <- serveHTTPS(ctx, server, listener, time.Second, func() error {
			_ = listener.closeTransport()
			close(nodeClosed)
			return nil
		})
	}()

	respDone := make(chan error, 1)
	go func() {
		resp, err := http.Get("http://" + base.Addr().String() + "/active")
		if err != nil {
			respDone <- err
			return
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		if err == nil && (resp.StatusCode != http.StatusOK || string(body) != "drained") {
			err = fmt.Errorf("unexpected drained HTTP response: status=%d body=%q", resp.StatusCode, body)
		}
		respDone <- err
	}()
	select {
	case <-httpStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("ordinary HTTP request did not become active")
	}

	wsConn, err := net.Dial("tcp", base.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer wsConn.Close()
	if _, err := io.WriteString(wsConn, "GET /upgrade HTTP/1.1\r\nHost: test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	wsReader := bufio.NewReader(wsConn)
	status, err := wsReader.ReadString('\n')
	if err != nil || !strings.Contains(status, "101 Switching Protocols") {
		t.Fatalf("upgrade response = %q, err = %v", status, err)
	}
	for {
		line, readErr := wsReader.ReadString('\n')
		if readErr != nil {
			t.Fatal(readErr)
		}
		if line == "\r\n" {
			break
		}
	}
	select {
	case <-wsUpgraded:
	case <-time.After(time.Second):
		t.Fatal("handler did not observe the upgraded connection")
	}

	// The executable's signal.NotifyContext is canceled by SIGTERM/SIGINT.
	// Cancel the same context here without signaling the test process itself.
	cancel()
	select {
	case <-nodeClosed:
		t.Fatal("tsnet transport closed before the active HTTP request drained")
	case <-time.After(50 * time.Millisecond):
	}
	_ = wsConn.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
	if _, err := wsReader.ReadByte(); err == nil {
		t.Fatal("unexpected data while checking the upgraded connection remains open")
	} else if timeout, ok := err.(net.Error); !ok || !timeout.Timeout() {
		t.Fatalf("upgraded WebSocket closed before tsnet close: %v", err)
	}
	_ = wsConn.SetReadDeadline(time.Time{})

	close(httpRelease)
	select {
	case err := <-respDone:
		if err != nil {
			t.Fatalf("active HTTP request did not drain: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("active HTTP response did not finish")
	}
	select {
	case err := <-runDone:
		if err != nil {
			t.Fatalf("serveHTTPS returned error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("serveHTTPS did not finish shutdown")
	}
	select {
	case <-nodeClosed:
	default:
		t.Fatal("tsnet transport was not closed")
	}
	_ = wsConn.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := wsReader.ReadByte(); err == nil {
		t.Fatal("upgraded connection survived fake tsnet transport close")
	} else if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
		t.Fatalf("upgraded connection remained open after fake tsnet transport close: %v", err)
	}
}

func TestServeHTTPSShutdownTimeoutClosesServerAndTransport(t *testing.T) {
	base, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	listener := &fakeTsnetListener{Listener: base}
	requestStarted := make(chan struct{})
	requestRelease := make(chan struct{})
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(requestStarted)
		<-requestRelease
		_, _ = io.WriteString(w, "late")
	})}
	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan error, 1)
	transportClosed := make(chan struct{})
	go func() {
		runDone <- serveHTTPS(ctx, server, listener, 25*time.Millisecond, func() error {
			_ = listener.closeTransport()
			close(transportClosed)
			return nil
		})
	}()
	respDone := make(chan struct{})
	go func() {
		resp, err := http.Get("http://" + base.Addr().String() + "/blocked")
		if err == nil {
			_ = resp.Body.Close()
		}
		close(respDone)
	}()
	select {
	case <-requestStarted:
	case <-time.After(time.Second):
		t.Fatal("blocked HTTP request did not start")
	}
	cancel()
	select {
	case err := <-runDone:
		if err != nil {
			t.Fatalf("serveHTTPS returned error after bounded shutdown: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("shutdown timeout did not close server and transport")
	}
	select {
	case <-transportClosed:
	default:
		t.Fatal("tsnet transport close callback was not called")
	}
	close(requestRelease)
	select {
	case <-respDone:
	case <-time.After(time.Second):
		t.Fatal("HTTP client did not observe forced connection close")
	}
}

// TestServeAllClosesNodeOnceAfterEveryListenerDrains covers the multi-listener
// coordinator: two listeners, both drained, one node close, after the last.
func TestServeAllClosesNodeOnceAfterEveryListenerDrains(t *testing.T) {
	var bases []*fakeTsnetListener
	var servers []*http.Server
	var listeners []net.Listener
	for index := 0; index < 2; index++ {
		base, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil { t.Fatal(err) }
		fake := &fakeTsnetListener{Listener: base}
		bases = append(bases, fake)
		servers = append(servers, &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		})})
		listeners = append(listeners, fake)
	}
	ctx, cancel := context.WithCancel(context.Background())
	closed := make(chan int, 4)
	var closeCount int32
	done := make(chan error, 1)
	go func() {
		done <- serveAll(ctx, servers, listeners, time.Second, func() error {
			atomic.AddInt32(&closeCount, 1)
			closed <- int(atomic.LoadInt32(&closeCount))
			return nil
		})
	}()
	for _, fake := range bases {
		resp, err := http.Get("http://" + fake.Addr().String() + "/")
		if err != nil { t.Fatal(err) }
		resp.Body.Close()
	}
	cancel()
	select {
	case err := <-done:
		if err != nil { t.Fatalf("serveAll returned %v", err) }
	case <-time.After(5 * time.Second):
		t.Fatal("serveAll did not return after cancellation")
	}
	if count := atomic.LoadInt32(&closeCount); count != 1 {
		t.Fatalf("node closed %d times, want exactly once", count)
	}
	select {
	case <-closed:
	default:
		t.Fatal("node close was not observed")
	}
}

func TestServeAllRefusesEmptyOrMismatchedListeners(t *testing.T) {
	if err := serveAll(context.Background(), nil, nil, time.Second, func() error { return nil }); err == nil {
		t.Fatal("empty listener set accepted")
	}
	if err := serveAll(context.Background(), []*http.Server{{}}, nil, time.Second, func() error { return nil }); err == nil {
		t.Fatal("mismatched listener set accepted")
	}
}
