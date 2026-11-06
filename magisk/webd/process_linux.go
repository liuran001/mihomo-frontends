package main

import (
	"errors"
	"net"
	"os"
	"os/exec"
	"syscall"
	"time"
)

func setupProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.Cancel = func() error {
		if command.Process == nil {
			return os.ErrProcessDone
		}
		err := syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
}

func cleanupProcess(command *exec.Cmd) {
	if command.Process != nil {
		_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
	}
}

func setupScrcpyProcess(command *exec.Cmd) {
	setupProcess(command)
	command.SysProcAttr.Pdeathsig = syscall.SIGKILL
}

func verifyScrcpyPeer(connection *net.UnixConn, processID int) error {
	raw, err := connection.SyscallConn()
	if err != nil {
		return err
	}
	var credential *syscall.Ucred
	var credentialErr error
	if err := raw.Control(func(descriptor uintptr) {
		credential, credentialErr = syscall.GetsockoptUcred(int(descriptor), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil {
		return err
	}
	if credentialErr != nil || !scrcpyPeerMatches(credential, processID, uint32(os.Getuid())) {
		return errors.New("屏幕本地连接身份不匹配")
	}
	return nil
}

func scrcpyPeerMatches(credential *syscall.Ucred, processID int, ownerID uint32) bool {
	return credential != nil && int(credential.Pid) == processID &&
		(credential.Uid == ownerID || ownerID == 0 && credential.Uid == 2000)
}

func lockConfigFile(file *os.File) error {
	deadline := time.Now().Add(3 * time.Second)
	for {
		err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EINTR) {
			return err
		}
		if time.Now().After(deadline) {
			return errors.New("网页管理设置正被修改，请稍后重试")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func unlockConfigFile(file *os.File) {
	_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
}
