package main

import (
	"errors"
	"net"
	"os"
	"os/exec"
)

func setupProcess(command *exec.Cmd) {}

func cleanupProcess(command *exec.Cmd) {}

func setupScrcpyProcess(command *exec.Cmd) { setupProcess(command) }

func verifyScrcpyPeer(connection *net.UnixConn, processID int) error {
	return errors.New("内置屏幕服务需要 Android/Linux")
}

func lockConfigFile(file *os.File) error { return nil }

func unlockConfigFile(file *os.File) {}
