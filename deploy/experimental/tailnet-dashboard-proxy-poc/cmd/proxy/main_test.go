package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestValidServiceUIDRequiresDistinctNonRootUID(t *testing.T) {
	for _, tc := range []struct { service, pilot int; want bool }{{1001,1002,true},{0,1002,false},{1001,1001,false},{1001,-1,false}} {
		if got:=validServiceUID(tc.service,tc.pilot);got!=tc.want { t.Fatalf("validServiceUID(%d,%d)=%v, want %v",tc.service,tc.pilot,got,tc.want) }
	}
}

func TestProtectedPathRejectsSymlinkAndUnsafePermissions(t *testing.T) {
	root:=t.TempDir(); state:=filepath.Join(root,"state")
	if err:=os.Mkdir(state,0700);err!=nil{t.Fatal(err)}
	if err:=protectedPath(state,true,os.Geteuid());err!=nil{t.Fatalf("safe state directory rejected: %v",err)}
	link:=filepath.Join(root,"state-link");if err:=os.Symlink(state,link);err!=nil{t.Fatal(err)}
	if err:=protectedPath(link,true,os.Geteuid());err==nil{t.Fatal("symlink state path accepted")}
	key:=filepath.Join(root,"key.pem");if err:=os.WriteFile(key,[]byte("fixture"),0600);err!=nil{t.Fatal(err)}
	if err:=protectedPath(key,false,os.Geteuid());err!=nil{t.Fatalf("safe key rejected: %v",err)}
	if err:=os.Chmod(key,0644);err!=nil{t.Fatal(err)}
	if err:=protectedPath(key,false,os.Geteuid());err==nil{t.Fatal("group/other-readable key accepted")}
}
