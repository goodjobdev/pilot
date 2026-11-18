package dashboardproxy

import (
 "bufio"
 "context"
 "crypto/ed25519"
 "crypto/rand"
 "encoding/base64"
 "encoding/json"
 "io"
 "net"
 "net/http"
 "net/http/httptest"
 "net/netip"
 "strings"
 "testing"
 "time"

 "pilot-tailnet-dashboard-proxy/ingress"
)
type who struct { peer ingress.Peer }
func (w who) WhoIs(_ context.Context,_ string)(ingress.Peer,error){return w.peer,nil}
func config(dest string, key ed25519.PrivateKey) Config { return Config{Lookup:who{ingress.Peer{Login:"owner@example.test",NodeID:"approved"}},Policy:ingress.Policy{OwnerLogin:"owner@example.test",AllowedNodeIDs:map[string]struct{}{"approved":{}},GatewayNodeID:"gateway",HostNodeID:"host"},Destination:netip.MustParseAddrPort(dest),DashboardHost:"dashboard.example.test",DashboardOrigin:"https://dashboard.example.test",Issuer:"https://gateway.tailnet.test",Audience:"pilot-dashboard",Owner:"owner@example.test",SigningKey:key} }
func signedClaims(t *testing.T, token string, pub ed25519.PublicKey) claims {t.Helper();parts:=strings.Split(token,".");if len(parts)!=3{t.Fatalf("bad JWT segments")};body:=[]byte(parts[0]+"."+parts[1]);sig,e:=base64.RawURLEncoding.DecodeString(parts[2]);if e!=nil||!ed25519.Verify(pub,body,sig){t.Fatal("bad EdDSA signature")};p,e:=base64.RawURLEncoding.DecodeString(parts[1]);if e!=nil{t.Fatal(e)};var c claims;if e=json.Unmarshal(p,&c);e!=nil{t.Fatal(e)};return c}
func TestGatewayHTTPFreshAssertionAndFixedHeaders(t *testing.T){pub,key,_:=ed25519.GenerateKey(rand.Reader);var got []claims;backend:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){got=append(got,signedClaims(t,r.Header.Get(assertionHeader),pub));if r.Host!="dashboard.example.test"||r.Header.Get("Origin")!=""{t.Errorf("backend Host/Origin = %q/%q",r.Host,r.Header.Get("Origin"))};for _,h:=range []string{"CF-Access-Jwt-Assertion","X-Pilot-Forged","Tailscale-User-Login","X-Forwarded-For","Authorization"}{if r.Header.Get(h)!=""{t.Errorf("forwarded %s",h)}};w.WriteHeader(200);io.WriteString(w,"dashboard") }));defer backend.Close();addr:=strings.TrimPrefix(backend.URL,"http://");c:=config(addr,key);c.Now=func()time.Time{return time.Unix(1700000000,0)};g,e:=New(c);if e!=nil{t.Fatal(e)};defer g.Close();srv:=httptest.NewServer(g.Handler);defer srv.Close()
 for i:=0;i<2;i++{req,_:=http.NewRequest("GET",srv.URL+"/whatever",nil);req.Host="dashboard.example.test";req.Header.Add("X-Pilot-Gateway-Assertion","forged-one");req.Header.Add("X-Pilot-Gateway-Assertion","forged-two");req.Header.Set("CF-Access-Jwt-Assertion","fake");req.Header.Set("Tailscale-User-Login","owner@example.test");req.Header.Set("X-Forwarded-For","127.0.0.1");req.Header.Set("Authorization","Bearer fake");res,e:=http.DefaultClient.Do(req);if e!=nil{t.Fatal(e)};res.Body.Close();if res.StatusCode!=200{t.Fatalf("status %d",res.StatusCode)}}
 cross,_:=http.NewRequest("POST",srv.URL+"/api/projects",strings.NewReader(`{}`));cross.Host="dashboard.example.test";cross.Header.Set("Origin","https://attacker.example");cross.Header.Set("Content-Type","application/json");crossResponse,e:=http.DefaultClient.Do(cross);if e!=nil{t.Fatal(e)};crossResponse.Body.Close();if crossResponse.StatusCode!=403{t.Fatalf("cross-site write status=%d",crossResponse.StatusCode)}
 absentWrite,_:=http.NewRequest("POST",srv.URL+"/api/projects",strings.NewReader(`{}`));absentWrite.Host="dashboard.example.test";absentResponse,e:=http.DefaultClient.Do(absentWrite);if e!=nil{t.Fatal(e)};absentResponse.Body.Close();if absentResponse.StatusCode!=403{t.Fatalf("absent-Origin write status=%d",absentResponse.StatusCode)}
 wsReq,_:=http.NewRequest("GET",srv.URL+"/terminals/stream",nil);wsReq.Host="dashboard.example.test";wsReq.Header.Set("Upgrade","websocket");wsReq.Header.Set("Connection","Upgrade");wsReq.Header.Set("Origin","https://attacker.example");wsResp,e:=http.DefaultClient.Do(wsReq);if e!=nil{t.Fatal(e)};wsResp.Body.Close();if wsResp.StatusCode!=403{t.Fatalf("cross-site WebSocket status=%d",wsResp.StatusCode)}
 wsAbsent,_:=http.NewRequest("GET",srv.URL+"/terminals/stream",nil);wsAbsent.Host="dashboard.example.test";wsAbsent.Header.Set("Upgrade","websocket");wsAbsent.Header.Set("Connection","Upgrade");wsAbsentResp,e:=http.DefaultClient.Do(wsAbsent);if e!=nil{t.Fatal(e)};wsAbsentResp.Body.Close();if wsAbsentResp.StatusCode!=403{t.Fatalf("absent-Origin WebSocket status=%d",wsAbsentResp.StatusCode)}
 if len(got)!=2||got[0].ID==got[1].ID{t.Fatalf("assertions not unique: %#v",got)};for _,c:=range got{if c.Issuer!=cIssuer||c.Audience!="pilot-dashboard"||c.Subject!="owner@example.test"||c.Owner!="owner@example.test"||c.IssuedAt!=1700000000||c.Expires!=1700000030||c.Expires-c.IssuedAt>60{t.Fatalf("verifier claim mismatch: %#v",c)}} }
func TestGatewayRequiresPilotOriginHostAndRejectsIncomingHostMismatch(t *testing.T){
 pub,key,_:=ed25519.GenerateKey(rand.Reader);_ = pub
 backend:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){w.WriteHeader(200)}));defer backend.Close()
 c:=config(strings.TrimPrefix(backend.URL,"http://"),key);c.DashboardHost="pilot.internal.test"
 if _,err:=New(c);err==nil{t.Fatal("Host different from Pilot Origin host accepted")}
 c=config(strings.TrimPrefix(backend.URL,"http://"),key);g,err:=New(c);if err!=nil{t.Fatal(err)};defer g.Close()
 r:=httptest.NewRequest("GET","http://attacker.example/path",nil);r.Host="attacker.example";r.RemoteAddr="100.64.0.2:4";w:=httptest.NewRecorder();g.Handler.ServeHTTP(w,r);if w.Code!=403{t.Fatalf("mismatched incoming Host status=%d",w.Code)}
}
const cIssuer="https://gateway.tailnet.test"
func TestGatewayRejectsWrongPeerAndInvalidDestination(t *testing.T){pub,key,_:=ed25519.GenerateKey(rand.Reader);_ = pub;backend:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){w.WriteHeader(200)}));defer backend.Close();c:=config(strings.TrimPrefix(backend.URL,"http://"),key);c.Lookup=who{ingress.Peer{Login:"owner@example.test",NodeID:"other"}};g,e:=New(c);if e!=nil{t.Fatal(e)};defer g.Close();r:=httptest.NewRequest("GET","http://dashboard.example.test/not-found",nil);r.Host="dashboard.example.test";r.RemoteAddr="100.64.0.2:4";w:=httptest.NewRecorder();g.Handler.ServeHTTP(w,r);if w.Code!=403{t.Fatalf("wrong node status=%d",w.Code)};c.Destination=netip.MustParseAddrPort("8.8.8.8:80");if _,e=New(c);e==nil{t.Fatal("external destination accepted")}}
func TestGatewayWebSocketUpgradeAuthenticatedAndCleansAssertions(t *testing.T){pub,key,_:=ed25519.GenerateKey(rand.Reader);seen:=make(chan claims,1);backend:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){seen<-signedClaims(t,r.Header.Get(assertionHeader),pub);if r.Host!="dashboard.example.test"||r.Header.Get("Origin")!="https://dashboard.example.test"||r.Header.Get("CF-Access-Jwt-Assertion")!=""{t.Errorf("bad upgrade headers")};h:=w.(http.Hijacker);conn,rw,e:=h.Hijack();if e!=nil{t.Error(e);return};io.WriteString(rw,"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");rw.Flush();conn.Close()}));defer backend.Close();g,e:=New(config(strings.TrimPrefix(backend.URL,"http://"),key));if e!=nil{t.Fatal(e)};defer g.Close();srv:=httptest.NewServer(g.Handler);defer srv.Close();address:=strings.TrimPrefix(srv.URL,"http://");conn,e:=net.Dial("tcp",address);if e!=nil{t.Fatal(e)};defer conn.Close();io.WriteString(conn,"GET /terminals/stream HTTP/1.1\r\nHost: dashboard.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: https://dashboard.example.test\r\nCF-Access-Jwt-Assertion: forged\r\nX-Pilot-Gateway-Assertion: forged\r\n\r\n");conn.SetReadDeadline(time.Now().Add(3*time.Second));line,e:=bufio.NewReader(conn).ReadString('\n');if e!=nil||!strings.Contains(line,"101"){t.Fatalf("upgrade response %q %v",line,e)};select{case c:=<-seen:if c.Owner!="owner@example.test"{t.Fatal(c)};case <-time.After(2*time.Second):t.Fatal("backend did not receive websocket")}}
