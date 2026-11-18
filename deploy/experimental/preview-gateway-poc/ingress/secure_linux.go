//go:build linux

package ingress

import (
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

func validatePrivateDirectory(path string, serviceUID, pilotUID int) error {
	if serviceUID <= 0 || pilotUID <= 0 || serviceUID == pilotUID || os.Geteuid() != serviceUID || !filepath.IsAbs(path) || strings.ContainsRune(path, 0) {
		return fmt.Errorf("invalid private bridge UID/path configuration")
	}
	parent := filepath.Dir(filepath.Clean(path))
	parts := strings.Split(strings.TrimPrefix(parent, string(filepath.Separator)), string(filepath.Separator))
	if len(parts) == 1 && parts[0] == "" { return fmt.Errorf("private path cannot use filesystem root as parent") }
	current := string(filepath.Separator)
	for index, part := range parts {
		if part == "" { continue }
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil { return err }
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 { return fmt.Errorf("unsafe private directory component %s", current) }
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok { return fmt.Errorf("cannot verify owner of %s", current) }
		if index == len(parts)-1 {
			if int(stat.Uid) != serviceUID || info.Mode().Perm()&0077 != 0 { return fmt.Errorf("private parent must be service-owned mode 0700: %s", current) }
		} else if info.Mode().Perm()&0022 != 0 || (int(stat.Uid) != 0 && int(stat.Uid) != serviceUID) {
			return fmt.Errorf("ancestor must be root/service-owned and not group/other-writable: %s", current)
		}
	}
	return nil
}

// ValidateTsnetStateDirectory requires the tsnet state directory to exist before
// tsnet starts creating state files. The directory itself must be service-owned
// and private; every ancestor must be root/service-owned and not writable by
// group or other users. This is intentionally distinct from validating a socket
// or key's parent directory, which shares the component policy but has a file path.
func ValidateTsnetStateDirectory(path string, serviceUID, pilotUID int) error {
	if serviceUID <= 0 || pilotUID <= 0 || serviceUID == pilotUID || os.Geteuid() != serviceUID || !filepath.IsAbs(path) || strings.ContainsRune(path, 0) {
		return fmt.Errorf("invalid tsnet state directory UID/path configuration")
	}
	clean := filepath.Clean(path)
	if clean == string(filepath.Separator) {
		return fmt.Errorf("tsnet state directory cannot be filesystem root")
	}
	parts := strings.Split(strings.TrimPrefix(clean, string(filepath.Separator)), string(filepath.Separator))
	current := string(filepath.Separator)
	for index, part := range parts {
		if part == "" { continue }
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil { return err }
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("unsafe tsnet state directory component %s", current)
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok { return fmt.Errorf("cannot verify owner of %s", current) }
		if index == len(parts)-1 {
			if int(stat.Uid) != serviceUID || info.Mode().Perm() != 0700 {
				return fmt.Errorf("tsnet state directory must be service-owned mode 0700: %s", current)
			}
		} else if info.Mode().Perm()&0022 != 0 || (int(stat.Uid) != 0 && int(stat.Uid) != serviceUID) {
			return fmt.Errorf("tsnet state ancestor must be root/service-owned and not group/other-writable: %s", current)
		}
	}
	return nil
}

func readPrivateKey(path string, serviceUID, pilotUID int) ([]byte, error) {
	if !filepath.IsAbs(path) { return nil, fmt.Errorf("key path must be absolute") }
	if err := validatePrivateDirectory(path, serviceUID, pilotUID); err != nil { return nil, err }
	if os.Geteuid() != serviceUID { return nil, fmt.Errorf("key reader is not running as gateway service UID") }
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil { return nil, err }
	file := os.NewFile(uintptr(fd), path)
	defer file.Close()
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil { return nil, err }
	if stat.Mode&unix.S_IFMT != unix.S_IFREG || int(stat.Uid) != os.Geteuid() || stat.Mode&0077 != 0 || stat.Size != 64 {
		return nil, fmt.Errorf("key must be a service-owned regular 64-byte file inaccessible to group/other")
	}
	key := make([]byte, 65)
	n, err := io.ReadFull(file, key)
	if err != nil && err != io.ErrUnexpectedEOF { return nil, err }
	if n != 64 { return nil, fmt.Errorf("key must contain exactly 64 bytes") }
	return key[:64], nil
}

func readProtectedPEM(path string, serviceUID, pilotUID int) ([]byte, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path { return nil, fmt.Errorf("TLS material path must be absolute and canonical") }
	if err := validatePrivateDirectory(path, serviceUID, pilotUID); err != nil { return nil, err }
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil { return nil, err }
	file := os.NewFile(uintptr(fd), path)
	defer file.Close()
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil { return nil, err }
	const maxPEMSize = 1 << 20
	if stat.Mode&unix.S_IFMT != unix.S_IFREG || int(stat.Uid) != serviceUID || stat.Mode&0077 != 0 || stat.Size <= 0 || stat.Size > maxPEMSize {
		return nil, fmt.Errorf("TLS material must be a service-owned private regular file no larger than 1 MiB")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxPEMSize+1))
	if err != nil { return nil, err }
	if len(data) == 0 || len(data) > maxPEMSize { return nil, fmt.Errorf("invalid TLS material file size") }
	return data, nil
}

// ReadOwnerTLSMaterial reads the owner certificate and private key only from
// protected service-owned files; neither file may be reached through a symlink.
func ReadOwnerTLSMaterial(certPath, keyPath string, serviceUID, pilotUID int) ([]byte, []byte, error) {
	if certPath == keyPath { return nil, nil, fmt.Errorf("TLS certificate and key must be separate files") }
	if os.Geteuid() != serviceUID || serviceUID <= 0 || pilotUID <= 0 || serviceUID == pilotUID {
		return nil, nil, fmt.Errorf("invalid TLS material UID configuration")
	}
	certPEM, err := readProtectedPEM(certPath, serviceUID, pilotUID)
	if err != nil { return nil, nil, err }
	keyPEM, err := readProtectedPEM(keyPath, serviceUID, pilotUID)
	if err != nil { return nil, nil, err }
	return certPEM, keyPEM, nil
}

func validateSocketPath(path string, serviceUID, pilotUID int) error {
	if err := validatePrivateDirectory(path, serviceUID, pilotUID); err != nil { return err }
	info, err := os.Lstat(path)
	if err != nil { return err }
	if info.Mode()&os.ModeSocket == 0 || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0600 { return fmt.Errorf("preview socket must be a mode-0600 Unix socket") }
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != serviceUID { return fmt.Errorf("preview socket must be owned by gateway service UID") }
	return nil
}

func verifySocketPeer(conn net.Conn, expectedUID int) error {
	unixConn, ok := conn.(*net.UnixConn)
	if !ok { return fmt.Errorf("preview connection is not Unix domain") }
	raw, err := unixConn.SyscallConn()
	if err != nil { return err }
	var credential *unix.Ucred
	var controlErr error
	if err := raw.Control(func(fd uintptr) {
		credential, controlErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil { return err }
	if controlErr != nil { return controlErr }
	if credential == nil || int(credential.Uid) != expectedUID { return fmt.Errorf("preview socket peer UID mismatch") }
	return nil
}
