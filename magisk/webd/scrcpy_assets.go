package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

const scrcpyVersion = "5.0.1"
const scrcpyChecksum = "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536"
const scrcpyServerName = "scrcpy-server-v" + scrcpyVersion + ".jar"
const jmuxerChecksum = "1875ee9588b0a51b5ed3fbc679c50cc57324b9d202c8601473ac48e2526d6fca"
const jmuxerLicenseChecksum = "5b1eb9ebc7d01ba57c1acdd83171bceea7b4929de5de06eb1be44eb6bc5980f0"

type bundledAsset struct {
	name     string
	url      string
	checksum string
}

func assetMatches(path, checksum string) bool {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 2<<20 {
		return false
	}
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	hash := sha256.New()
	_, err = io.Copy(hash, io.LimitReader(file, 2<<20+1))
	return err == nil && hex.EncodeToString(hash.Sum(nil)) == checksum
}

func fetchBundledAsset(ctx context.Context, client *http.Client, directory string, asset bundledAsset) error {
	path := filepath.Join(directory, asset.name)
	if assetMatches(path, asset.checksum) {
		return nil
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, asset.url, nil)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.ContentLength > 2<<20 {
		return fmt.Errorf("%s: invalid download status/size (%d)", asset.name, response.StatusCode)
	}
	file, err := os.CreateTemp(directory, ".download-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	hash := sha256.New()
	size, copyErr := io.Copy(io.MultiWriter(file, hash), io.LimitReader(response.Body, 2<<20+1))
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil || size > 2<<20 || hex.EncodeToString(hash.Sum(nil)) != asset.checksum {
		return fmt.Errorf("%s: download incomplete or SHA-256 mismatch", asset.name)
	}
	if err := os.Chmod(file.Name(), 0o644); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

func prepareScrcpyAssets(directory string) error {
	if directory == "" {
		return errors.New("缺少屏幕资源输出目录")
	}
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return err
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("屏幕资源输出必须为普通目录")
	}
	client := &http.Client{Timeout: 90 * time.Second, CheckRedirect: func(request *http.Request, via []*http.Request) error {
		if request.URL.Scheme != "https" || len(via) > 5 {
			return errors.New("unsafe asset redirect")
		}
		return nil
	}}
	defer client.CloseIdleConnections()
	for _, asset := range []bundledAsset{
		{scrcpyServerName, "https://github.com/Genymobile/scrcpy/releases/download/v" + scrcpyVersion + "/scrcpy-server-v" + scrcpyVersion, scrcpyChecksum},
		{"SCRCPY-LICENSE.txt", "https://raw.githubusercontent.com/Genymobile/scrcpy/v" + scrcpyVersion + "/LICENSE", "01c12035bf35af37241298dc7ad538eb2a07e5c940437bc6876feeaa9d1951d0"},
		{"jmuxer.min.js", "https://cdn.jsdelivr.net/npm/jmuxer@2.1.4/dist/jmuxer.min.js", jmuxerChecksum},
		{"JMUXER-LICENSE.txt", "https://cdn.jsdelivr.net/npm/jmuxer@2.1.4/LICENSE", jmuxerLicenseChecksum},
	} {
		if err := fetchBundledAsset(context.Background(), client, directory, asset); err != nil {
			return fmt.Errorf("准备屏幕资源 %s：%w", asset.name, err)
		}
	}
	return nil
}
