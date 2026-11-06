package main

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

func fakeDeviceCommand(t *testing.T, name, output string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("Android shell command fixture")
	}
	directory := t.TempDir()
	command := "#!/bin/sh\ncat <<'MOCK_DEVICE_OUTPUT'\n" + output + "\nMOCK_DEVICE_OUTPUT\n"
	if err := os.WriteFile(filepath.Join(directory, name), []byte(command), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestDeviceBatteryAndSMSAreOnDemandAndBounded(t *testing.T) {
	fakeDeviceCommand(t, "dumpsys", "Current Battery Service state:\n  USB powered: true\n  level: 73\n  scale: 100\n  temperature: 320")
	fakeDeviceCommand(t, "content", "Row: 0 _id=12, address=+10000, date=100000000, type=1, body=first line\nsecond line\nRow: 1 _id=11, address=+20000, date=999999, type=2, body=sent")
	server := &Server{shell: "sh"}
	battery, err := server.readBattery(context.Background())
	if err != nil || battery["percent"] != 73 || battery["powered"] != true || battery["temperature"] != float64(32) {
		t.Fatalf("battery parse: %v %v", battery, err)
	}
	messages, err := server.readMessages(context.Background(), 20)
	if err != nil {
		t.Fatal(err)
	}
	rows := messages["messages"].([]map[string]any)
	if len(rows) != 2 || rows[0]["body"] != "first line\nsecond line" {
		t.Fatalf("multiline SMS parse: %v", rows)
	}
	if _, err := server.readMessages(context.Background(), 51); err == nil {
		t.Fatal("unbounded SMS query accepted")
	}
}

func TestHotspotUsesTetheringBridgeWithoutPasswordInArguments(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "bin"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "bin", "device-control.jar"), []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	fakeDeviceCommand(t, "app_process", `{"ok":true,"enabled":true,"tethered":true,"state":13,"submitted":true}`)
	server := &Server{scriptDir: filepath.Join(dir, "scripts"), dataDir: dir}
	enabled := true
	result, err := server.setHotspot(context.Background(), hotspotRequest{Enabled: &enabled, Config: &hotspotConfig{SSID: "Test Hotspot", Password: "sample-password", Band: "2"}})
	if err != nil || result["tethered"] != true || result["enabled"] != true {
		t.Fatalf("tethering result: %v %v", result, err)
	}
	info, err := os.Stat(filepath.Join(dir, "webui-hotspot.json"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatal("hotspot password file must be private")
	}
	fakeDeviceCommand(t, "app_process", `{"ok":false,"error":"ROM denied"}`)
	if _, err := server.setHotspot(context.Background(), hotspotRequest{Enabled: &enabled}); err == nil || !strings.Contains(err.Error(), "ROM denied") {
		t.Fatal("ROM failure was reported as success")
	}
	if _, err := server.setHotspot(context.Background(), hotspotRequest{}); err == nil {
		t.Fatal("empty hotspot action accepted")
	}
}

func TestTerminalTimeoutAndOutputBudget(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("requires POSIX shell")
	}
	server := &Server{shell: "sh"}
	started := time.Now()
	result, err := server.runTerminal(context.Background(), terminalRequest{Command: "sleep 30 & wait", Timeout: 1})
	if err != nil || time.Since(started) > 3*time.Second || result["errno"] != -1 {
		t.Fatalf("terminal cancellation: %v %v after %s", result, err, time.Since(started))
	}
	result, err = server.runTerminal(context.Background(), terminalRequest{Command: "head -c 300000 /dev/zero", Timeout: 2})
	if err != nil || result["truncated"] != true || len(result["stdout"].(string)) > 128<<10 {
		t.Fatal("terminal output is not bounded")
	}
	if _, err := server.runTerminal(context.Background(), terminalRequest{Command: "true", Timeout: 61}); err == nil {
		t.Fatal("terminal accepted unbounded timeout")
	}
}

func TestTerminalReapsOrdinaryBackgroundChildren(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("requires Linux process groups")
	}
	server := &Server{shell: "sh"}
	result, err := server.runTerminal(context.Background(), terminalRequest{Command: "sleep 30 >/dev/null 2>&1 & echo $!", Timeout: 3})
	if err != nil {
		t.Fatal(err)
	}
	identifier, err := strconv.Atoi(strings.TrimSpace(result["stdout"].(string)))
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for {
		data, readErr := os.ReadFile(filepath.Join("/proc", strconv.Itoa(identifier), "stat"))
		if os.IsNotExist(readErr) || strings.Contains(string(data), ") Z ") {
			break
		}
		if time.Now().After(deadline) {
			process, _ := os.FindProcess(identifier)
			if process != nil {
				_ = process.Kill()
			}
			t.Fatal("terminal left a live background child")
		}
		time.Sleep(20 * time.Millisecond)
	}
}
