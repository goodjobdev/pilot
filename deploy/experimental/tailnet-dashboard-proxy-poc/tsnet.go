package dashboardproxy

import (
 "context"
 "fmt"
 "tailscale.com/client/local"
 "pilot-tailnet-dashboard-proxy/ingress"
)
type TsnetWhoIs struct{ client *local.Client }
func NewTsnetWhoIs(client *local.Client)(*TsnetWhoIs,error){if client==nil{return nil,fmt.Errorf("nil tsnet LocalAPI client")};return &TsnetWhoIs{client},nil}
func(t *TsnetWhoIs)WhoIs(ctx context.Context,addr string)(ingress.Peer,error){r,e:=t.client.WhoIs(ctx,addr);if e!=nil{return ingress.Peer{},e};if r==nil||r.Node==nil||r.UserProfile==nil{return ingress.Peer{},fmt.Errorf("incomplete WhoIs")};p:=ingress.Peer{Login:r.UserProfile.LoginName,NodeID:string(r.Node.StableID),Tags:append([]string(nil),r.Node.Tags...)};if p.Login==""||p.NodeID==""{return ingress.Peer{},fmt.Errorf("empty WhoIs identity")};return p,nil}
