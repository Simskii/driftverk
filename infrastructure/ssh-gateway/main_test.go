package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/crypto/ssh"
)

func TestHostKeyPreservation(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	encoded := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	path := filepath.Join(t.TempDir(), "ssh_host_key")
	if err := os.WriteFile(path, encoded, 0600); err != nil {
		t.Fatal(err)
	}
	want, _ := ssh.NewSignerFromKey(key)
	for range 2 {
		got, err := hostSigner(path)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got.PublicKey().Marshal(), want.PublicKey().Marshal()) {
			t.Fatal("existing RSA host identity changed")
		}
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(after, encoded) {
		t.Fatal("existing host key file changed")
	}
	if err := os.WriteFile(path, []byte("invalid key"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := hostSigner(path); err == nil {
		t.Fatal("corrupt host key must fail, not rotate")
	}
}

func TestNewHostKeyIsPersistentAndPrivate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keys", "ssh_host_key")
	one, err := hostSigner(path)
	if err != nil {
		t.Fatal(err)
	}
	two, err := hostSigner(path)
	if err != nil {
		t.Fatal(err)
	}
	if ssh.FingerprintSHA256(one.PublicKey()) != ssh.FingerprintSHA256(two.PublicKey()) {
		t.Fatal("new key was rotated on restart")
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("host key must be mode 0600", err)
	}
}

func TestGatewayNegotiationAndExec(t *testing.T) {
	for _, algorithm := range []string{ssh.KeyExchangeMLKEM768X25519, ssh.KeyExchangeCurve25519} {
		t.Run(algorithm, func(t *testing.T) {
			_, userKey, _ := ed25519.GenerateKey(rand.Reader)
			userSigner, _ := ssh.NewSignerFromKey(userKey)
			fingerprint := ssh.FingerprintSHA256(userSigner.PublicKey())
			var authorizations atomic.Int64
			control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/gateway/ssh/authorize" || r.Header.Get("Authorization") != "Bearer control-secret" {
					t.Error("wrong authorization request")
					w.WriteHeader(403)
					return
				}
				var identity struct{ Target, Fingerprint string }
				if json.NewDecoder(r.Body).Decode(&identity) != nil || identity.Target != "acme.test" || identity.Fingerprint != fingerprint {
					t.Error("wrong SSH identity")
					w.WriteHeader(403)
					return
				}
				authorizations.Add(1)
				_ = json.NewEncoder(w).Encode(grant{NodeID: "node-a", Ticket: "ticket-a"})
			}))
			defer control.Close()
			upgrader := websocket.Upgrader{}
			bridgeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer bridge-secret" {
					t.Error("missing bridge authentication")
					w.WriteHeader(403)
					return
				}
				socket, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					t.Error(err)
					return
				}
				defer socket.Close()
				var request streamRequest
				if err := socket.ReadJSON(&request); err != nil {
					t.Error(err)
					return
				}
				if request.Type != "open" || request.NodeID != "node-a" || request.Ticket != "ticket-a" || request.Mode != "exec" || request.Command != "cat" {
					t.Errorf("wrong stream request: %+v", request)
				}
				var input []byte
				for {
					kind, data, err := socket.ReadMessage()
					if err != nil {
						t.Error(err)
						return
					}
					if kind == websocket.BinaryMessage {
						if len(data) < 1 || data[0] != 1 {
							t.Error("bad input frame")
							return
						}
						input = append(input, data[1:]...)
					} else {
						break
					}
				}
				_ = socket.WriteMessage(websocket.BinaryMessage, append([]byte{1}, input...))
				_ = socket.WriteMessage(websocket.BinaryMessage, []byte("\x02test stderr"))
				_ = socket.WriteJSON(map[string]any{"type": "exit", "code": 7})
			}))
			defer bridgeServer.Close()
			hostKey, err := hostSigner(filepath.Join(t.TempDir(), "host"))
			if err != nil {
				t.Fatal(err)
			}
			g := &gateway{config: config{controlURL: control.URL, token: "control-secret", bridgeURL: "ws" + strings.TrimPrefix(bridgeServer.URL, "http"), bridgeSecret: "bridge-secret"}, client: &http.Client{Timeout: time.Second}}
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			done := make(chan struct{})
			go func() {
				defer close(done)
				raw, err := listener.Accept()
				if err == nil {
					g.clients.Add(1)
					g.serveConnection(raw, hostKey)
				}
			}()
			client, err := ssh.Dial("tcp", listener.Addr().String(), &ssh.ClientConfig{
				User: "acme.test", Auth: []ssh.AuthMethod{ssh.PublicKeys(userSigner)}, HostKeyCallback: ssh.FixedHostKey(hostKey.PublicKey()),
				Config: ssh.Config{KeyExchanges: []string{algorithm}}, Timeout: 5 * time.Second,
			})
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				client.Close()
				select {
				case <-done:
				case <-time.After(3 * time.Second):
					t.Error("SSH connection did not stop")
				}
			}()
			if got := client.Conn.(ssh.AlgorithmsConnMetadata).Algorithms().KeyExchange; got != algorithm {
				t.Fatalf("negotiated %s, want %s", got, algorithm)
			}
			session, err := client.NewSession()
			if err != nil {
				t.Fatal(err)
			}
			defer session.Close()
			var stdout, stderr bytes.Buffer
			session.Stdout, session.Stderr, session.Stdin = &stdout, &stderr, strings.NewReader("input survives EOF")
			err = session.Run("cat")
			if exit, ok := err.(*ssh.ExitError); !ok || exit.ExitStatus() != 7 {
				t.Fatalf("wrong exit: %v", err)
			}
			if stdout.String() != "input survives EOF" || stderr.String() != "test stderr" {
				t.Fatalf("wrong output: %q / %q", stdout.String(), stderr.String())
			}
			if authorizations.Load() < 2 {
				t.Fatal("channel was not reauthorized after login")
			}
		})
	}
}

func TestAuthorizationFailsClosed(t *testing.T) {
	for _, status := range []int{401, 403, 500} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(status); _, _ = io.WriteString(w, "{}") }))
		g := &gateway{config: config{controlURL: server.URL}, client: server.Client()}
		_, err := g.authorize(context.Background(), "target", "fingerprint")
		server.Close()
		if err == nil {
			t.Fatalf("accepted status %d", status)
		}
		if (status == 401 || status == 403) && err != errAccessDenied {
			t.Fatalf("status %d must revoke immediately", status)
		}
		if status == 500 && err == errAccessDenied {
			t.Fatal("outage should have existing-session grace")
		}
	}
}
