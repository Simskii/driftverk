// SSH terminates here. Environment access and agent routing remain in Driftverk.
package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/crypto/ssh"
)

type config struct {
	controlURL, token, bridgeURL, bridgeSecret, hostKey, port, healthAddr string
}

type grant struct {
	NodeID string `json:"node_id"`
	Ticket string `json:"ticket"`
}

type gateway struct {
	config   config
	client   *http.Client
	clients  atomic.Int64
	draining atomic.Bool
}

// Bound stalled network writes without imposing an idle timeout on shells.
type writeDeadlineConn struct{ net.Conn }

func (c writeDeadlineConn) Write(data []byte) (int, error) {
	_ = c.Conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
	return c.Conn.Write(data)
}

var errAccessDenied = errors.New("SSH access denied")

func env(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func loadConfig() (config, error) {
	c := config{
		controlURL: strings.TrimRight(env("CONTROL_PLANE_URL", ""), "/"),
		token:      env("SSH_TOKEN_SECRET", ""), bridgeURL: env("SSH_BRIDGE_URL", "ws://data-gateway:3002/ssh"),
		bridgeSecret: env("SSH_BRIDGE_SECRET", ""), hostKey: env("SSH_HOST_KEY_PATH", "/data/ssh_host_key"),
		port: env("SSH_GATEWAY_PORT", "2222"), healthAddr: env("SSH_HEALTH_ADDR", "0.0.0.0:3003"),
	}
	if len(c.token) < 32 || len(c.bridgeSecret) < 32 {
		return c, errors.New("SSH_TOKEN_SECRET and SSH_BRIDGE_SECRET must each contain at least 32 characters")
	}
	for _, endpoint := range []struct{ value, scheme1, scheme2 string }{{c.controlURL, "http", "https"}, {c.bridgeURL, "ws", "wss"}} {
		u, err := url.Parse(endpoint.value)
		if err != nil || u.Host == "" || u.User != nil || (u.Scheme != endpoint.scheme1 && u.Scheme != endpoint.scheme2) {
			return c, errors.New("invalid gateway endpoint URL")
		}
	}
	p, err := strconv.Atoi(c.port)
	if err != nil || p < 1 || p > 65535 {
		return c, errors.New("invalid SSH_GATEWAY_PORT")
	}
	return c, nil
}

func hostSigner(path string) (ssh.Signer, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		_, key, keyErr := ed25519.GenerateKey(rand.Reader)
		if keyErr != nil {
			return nil, keyErr
		}
		block, keyErr := ssh.MarshalPrivateKey(key, "Driftverk SSH gateway")
		if keyErr != nil {
			return nil, keyErr
		}
		if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return nil, err
		}
		file, createErr := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if errors.Is(createErr, os.ErrExist) {
			data, err = os.ReadFile(path)
		} else {
			if createErr != nil {
				return nil, createErr
			}
			data = pem.EncodeToMemory(block)
			_, err = file.Write(data)
			closeErr := file.Close()
			if err == nil {
				err = closeErr
			}
		}
	}
	if err != nil {
		return nil, err
	}
	// Parse existing RSA/PKCS#1 and OpenSSH keys without rotating identity.
	return ssh.ParsePrivateKey(data)
}

func (g *gateway) authorize(ctx context.Context, username, fingerprint string) (grant, error) {
	body, _ := json.Marshal(map[string]string{"target": username, "fingerprint": fingerprint})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.config.controlURL+"/api/gateway/ssh/authorize", strings.NewReader(string(body)))
	if err != nil {
		return grant{}, err
	}
	req.Header.Set("Authorization", "Bearer "+g.config.token)
	req.Header.Set("Content-Type", "application/json")
	response, err := g.client.Do(req)
	if err != nil {
		return grant{}, errors.New("SSH authorization unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode == 401 || response.StatusCode == 403 {
		return grant{}, errAccessDenied
	}
	if response.StatusCode != 200 {
		return grant{}, errors.New("SSH authorization unavailable")
	}
	var result grant
	if err = json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&result); err != nil || result.NodeID == "" || result.Ticket == "" {
		return grant{}, errors.New("invalid SSH authorization response")
	}
	return result, nil
}

func (g *gateway) serveConnection(raw net.Conn, signer ssh.Signer) {
	defer raw.Close()
	defer g.clients.Add(-1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	algorithms := ssh.SupportedAlgorithms()
	serverConfig := &ssh.ServerConfig{
		Config:                  ssh.Config{KeyExchanges: algorithms.KeyExchanges, Ciphers: algorithms.Ciphers, MACs: algorithms.MACs},
		MaxAuthTries:            6,
		PublicKeyAuthAlgorithms: algorithms.PublicKeyAuths,
		PublicKeyCallback: func(meta ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			fingerprint := ssh.FingerprintSHA256(key)
			if _, err := g.authorize(ctx, meta.User(), fingerprint); err != nil {
				return nil, err
			}
			return &ssh.Permissions{Extensions: map[string]string{"fingerprint": fingerprint}}, nil
		},
	}
	serverConfig.AddHostKey(signer)
	_ = raw.SetDeadline(time.Now().Add(15 * time.Second))
	conn, channels, requests, err := ssh.NewServerConn(writeDeadlineConn{raw}, serverConfig)
	if err != nil {
		return
	}
	_ = raw.SetDeadline(time.Time{})
	defer conn.Close()
	fingerprint := conn.Permissions.Extensions["fingerprint"]
	go g.checkAccess(ctx, conn, fingerprint)
	go ssh.DiscardRequests(requests)
	// Bound channels per connection as well as the gateway-wide connection cap.
	active := make(chan struct{}, 64)
	for incoming := range channels {
		select {
		case active <- struct{}{}:
			go func(ch ssh.NewChannel) {
				defer func() { <-active }()
				g.handleChannel(ctx, conn, fingerprint, ch)
			}(incoming)
		default:
			_ = incoming.Reject(ssh.ResourceShortage, "Too many SSH channels")
		}
	}
}

func (g *gateway) checkAccess(ctx context.Context, conn *ssh.ServerConn, fingerprint string) {
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	lastAuthorized := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_, err := g.authorize(ctx, conn.User(), fingerprint)
			if err == nil {
				lastAuthorized = time.Now()
			} else if errors.Is(err, errAccessDenied) || time.Since(lastAuthorized) >= time.Minute {
				_ = conn.Close()
				return
			}
		}
	}
}

type pty struct {
	Term string `json:"term"`
	Cols uint32 `json:"cols"`
	Rows uint32 `json:"rows"`
}

type destination struct {
	Host string `json:"host"`
	Port uint32 `json:"port"`
}

type streamRequest struct {
	Type        string       `json:"type"`
	NodeID      string       `json:"node_id"`
	Ticket      string       `json:"ticket"`
	Mode        string       `json:"mode"`
	Command     string       `json:"command"`
	Pty         *pty         `json:"pty,omitempty"`
	Destination *destination `json:"destination,omitempty"`
}

type bridge struct {
	socket *websocket.Conn
	mu     sync.Mutex
}

func (b *bridge) write(kind int, data []byte) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	_ = b.socket.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return b.socket.WriteMessage(kind, data)
}

func (b *bridge) json(value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return b.write(websocket.TextMessage, data)
}

func (g *gateway) openBridge(ctx context.Context, username, fingerprint string, request streamRequest) (*bridge, error) {
	access, err := g.authorize(ctx, username, fingerprint)
	if err != nil {
		return nil, err
	}
	dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second}
	socket, response, err := dialer.DialContext(ctx, g.config.bridgeURL, http.Header{"Authorization": {"Bearer " + g.config.bridgeSecret}})
	if err != nil {
		if response != nil {
			response.Body.Close()
		}
		return nil, errors.New("SSH data gateway unavailable")
	}
	socket.SetReadLimit(8 * 1024 * 1024)
	_ = socket.SetReadDeadline(time.Now().Add(60 * time.Second))
	socket.SetPingHandler(func(data string) error {
		_ = socket.SetReadDeadline(time.Now().Add(60 * time.Second))
		return socket.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(10*time.Second))
	})
	b := &bridge{socket: socket}
	request.Type, request.NodeID, request.Ticket = "open", access.NodeID, access.Ticket
	if err = b.json(request); err != nil {
		socket.Close()
		return nil, err
	}
	return b, nil
}

func (g *gateway) handleChannel(ctx context.Context, conn *ssh.ServerConn, fingerprint string, incoming ssh.NewChannel) {
	username := conn.User()
	switch incoming.ChannelType() {
	case "session":
		if len(incoming.ExtraData()) != 0 {
			_ = incoming.Reject(ssh.ConnectionFailed, "Invalid session")
			return
		}
		channel, requests, err := incoming.Accept()
		if err != nil {
			return
		}
		defer channel.Close()
		g.session(ctx, conn, fingerprint, channel, requests)
	case "direct-tcpip":
		var value struct {
			Host       string
			Port       uint32
			Origin     string
			OriginPort uint32
		}
		if ssh.Unmarshal(incoming.ExtraData(), &value) != nil || (value.Host != "127.0.0.1" && value.Host != "::1" && value.Host != "localhost") || value.Port == 0 || value.Port > 65535 {
			_ = incoming.Reject(ssh.Prohibited, "Only environment loopback forwarding is allowed")
			return
		}
		b, err := g.openBridge(ctx, username, fingerprint, streamRequest{Mode: "tcp", Destination: &destination{Host: "127.0.0.1", Port: value.Port}})
		if err != nil {
			_ = incoming.Reject(ssh.Prohibited, "Forwarding authorization or routing failed")
			return
		}
		defer b.socket.Close()
		channel, requests, err := incoming.Accept()
		if err != nil {
			return
		}
		defer channel.Close()
		go func() {
			defer b.socket.Close()
			ssh.DiscardRequests(requests)
		}()
		g.pump(ctx, conn, channel, b, false)
	default:
		_ = incoming.Reject(ssh.UnknownChannelType, "Unsupported SSH channel")
	}
}

func (g *gateway) session(ctx context.Context, conn *ssh.ServerConn, fingerprint string, channel ssh.Channel, requests <-chan *ssh.Request) {
	var terminal *pty
	for request := range requests {
		switch request.Type {
		case "pty-req":
			var value struct {
				Term                      string
				Cols, Rows, Width, Height uint32
				Modes                     string
			}
			valid := terminal == nil && ssh.Unmarshal(request.Payload, &value) == nil && len(value.Term) <= 256
			if valid {
				terminal = &pty{Term: value.Term, Cols: dimension(value.Cols, 80, 500), Rows: dimension(value.Rows, 24, 200)}
			}
			_ = request.Reply(valid, nil)
		case "shell", "exec":
			command := ""
			valid := len(request.Payload) == 0
			if request.Type == "exec" {
				var value struct{ Command string }
				valid = ssh.Unmarshal(request.Payload, &value) == nil && len(value.Command) <= 16*1024
				command = value.Command
			}
			if !valid {
				_ = request.Reply(false, nil)
				continue
			}
			b, err := g.openBridge(ctx, conn.User(), fingerprint, streamRequest{Mode: request.Type, Command: command, Pty: terminal})
			if err != nil {
				_ = request.Reply(true, nil)
				_, _ = io.WriteString(channel.Stderr(), err.Error()+"\n")
				_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Code uint32 }{255}))
				return
			}
			defer b.socket.Close()
			_ = request.Reply(true, nil)
			go func() {
				defer b.socket.Close()
				for request := range requests {
					valid := false
					if request.Type == "window-change" && terminal != nil {
						var size struct{ Cols, Rows, Width, Height uint32 }
						if ssh.Unmarshal(request.Payload, &size) == nil && size.Cols > 0 && size.Rows > 0 {
							valid = b.json(map[string]any{"type": "resize", "cols": min(size.Cols, 500), "rows": min(size.Rows, 200)}) == nil
						}
					}
					_ = request.Reply(valid, nil)
				}
			}()
			g.pump(ctx, conn, channel, b, true)
			return
		default:
			_ = request.Reply(false, nil)
		}
	}
}

func dimension(value, fallback, limit uint32) uint32 {
	if value == 0 {
		return fallback
	}
	return min(value, limit)
}

func (g *gateway) pump(ctx context.Context, conn *ssh.ServerConn, channel ssh.Channel, b *bridge, session bool) {
	stop := context.AfterFunc(ctx, func() { b.socket.Close(); channel.Close() })
	defer stop()
	go func() {
		buffer := make([]byte, 32*1024+1)
		buffer[0] = 1
		for {
			n, err := channel.Read(buffer[1:])
			if n > 0 {
				if writeErr := b.write(websocket.BinaryMessage, buffer[:n+1]); writeErr != nil {
					b.socket.Close()
					return
				}
			}
			if err != nil {
				if errors.Is(err, io.EOF) {
					if b.json(map[string]string{"type": "end"}) != nil {
						b.socket.Close()
					}
				} else {
					b.socket.Close()
				}
				return
			}
		}
	}()
	exited := false
	defer func() {
		if session && !exited {
			_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Code uint32 }{255}))
		}
	}()
	for {
		kind, data, err := b.socket.ReadMessage()
		if err != nil {
			return
		}
		_ = b.socket.SetReadDeadline(time.Now().Add(60 * time.Second))
		if kind == websocket.BinaryMessage {
			if len(data) < 1 {
				return
			}
			var writer io.Writer = channel
			if data[0] == 2 && session {
				writer = channel.Stderr()
			} else if data[0] != 1 {
				return
			}
			// A peer can stop replenishing its SSH window while still sending
			// keepalives. Closing the connection releases blocked window writers;
			// sending channel-close alone does not unblock them in x/crypto/ssh.
			stalled := time.AfterFunc(60*time.Second, func() { conn.Close() })
			_, err = writer.Write(data[1:])
			stalled.Stop()
			if err != nil {
				return
			}
		} else {
			var event struct {
				Type string `json:"type"`
				Code uint32 `json:"code"`
			}
			if json.Unmarshal(data, &event) != nil || event.Type != "exit" || !session {
				return
			}
			_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Code uint32 }{event.Code}))
			exited = true
			return
		}
	}
}

func run() error {
	c, err := loadConfig()
	if err != nil {
		return err
	}
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		_, port, err := net.SplitHostPort(c.healthAddr)
		if err != nil {
			return err
		}
		client := http.Client{Timeout: 3 * time.Second}
		response, err := client.Get("http://127.0.0.1:" + port + "/health")
		if err != nil {
			return err
		}
		defer response.Body.Close()
		if response.StatusCode != 200 {
			return errors.New("SSH gateway unhealthy")
		}
		return nil
	}
	signer, err := hostSigner(c.hostKey)
	if err != nil {
		return fmt.Errorf("load SSH host key: %w", err)
	}
	g := &gateway{config: c, client: &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	listener, err := net.Listen("tcp", ":"+c.port)
	if err != nil {
		return err
	}
	defer listener.Close()
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if g.draining.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ssh_clients": g.clients.Load(), "draining": g.draining.Load()})
	})
	health := &http.Server{Addr: c.healthAddr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	healthListener, err := net.Listen("tcp", c.healthAddr)
	if err != nil {
		return err
	}
	defer health.Close()
	go func() { _ = health.Serve(healthListener) }()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() { <-ctx.Done(); g.draining.Store(true); listener.Close() }()
	log.Printf("SSH gateway listening on %s", listener.Addr())
	var connections sync.WaitGroup
	for {
		raw, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			return err
		}
		if g.clients.Add(1) > 512 {
			g.clients.Add(-1)
			raw.Close()
			continue
		}
		connections.Add(1)
		go func() { defer connections.Done(); g.serveConnection(raw, signer) }()
	}
	done := make(chan struct{})
	go func() { connections.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(60 * time.Second):
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
