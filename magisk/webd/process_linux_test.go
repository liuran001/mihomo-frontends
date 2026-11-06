package main

import (
	"syscall"
	"testing"
)

func TestScrcpyPeerRequiresChildPIDAndExpectedUID(t *testing.T) {
	for _, check := range []struct {
		name       string
		owner      uint32
		credential *syscall.Ucred
		allowed    bool
	}{
		{"root child", 0, &syscall.Ucred{Pid: 42, Uid: 0}, true},
		{"scrcpy drops root to shell", 0, &syscall.Ucred{Pid: 42, Uid: 2000}, true},
		{"shell child", 2000, &syscall.Ucred{Pid: 42, Uid: 2000}, true},
		{"foreign shell process", 0, &syscall.Ucred{Pid: 43, Uid: 2000}, false},
		{"foreign root process", 0, &syscall.Ucred{Pid: 43, Uid: 0}, false},
		{"application user", 0, &syscall.Ucred{Pid: 42, Uid: 10001}, false},
		{"shell cannot elevate", 2000, &syscall.Ucred{Pid: 42, Uid: 0}, false},
		{"missing credentials", 0, nil, false},
	} {
		t.Run(check.name, func(t *testing.T) {
			if allowed := scrcpyPeerMatches(check.credential, 42, check.owner); allowed != check.allowed {
				t.Fatalf("peer permission: got %v want %v", allowed, check.allowed)
			}
		})
	}
}
