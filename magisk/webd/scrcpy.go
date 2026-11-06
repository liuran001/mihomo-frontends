package main

import (
	"context"
	"crypto/rand"
	"embed"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
)

const scrcpyPacketLimit = 2 << 20

//go:embed screen/index.html screen/screen.js screen/screen.css
var screenAssets embed.FS

type scrcpySession struct {
	cancel  context.CancelFunc
	started time.Time
	ready   atomic.Bool
	done    chan struct{}
}

type scrcpyOutput struct {
	mu   sync.Mutex
	data limitedOutput
}

func (output *scrcpyOutput) Write(data []byte) (int, error) {
	output.mu.Lock()
	defer output.mu.Unlock()
	return output.data.Write(data)
}

func (output *scrcpyOutput) String() string {
	output.mu.Lock()
	defer output.mu.Unlock()
	return strings.TrimSpace(strings.ToValidUTF8(string(output.data.data), "�"))
}

func (s *Server) scrcpyAssetPath(name string) string {
	return filepath.Join(filepath.Dir(s.scriptDir), "bin", "scrcpy", name)
}

func (s *Server) scrcpyStatus() map[string]any {
	info, err := os.Stat(s.scrcpyAssetPath(scrcpyServerName))
	installed := err == nil && info.Mode().IsRegular() && info.Size() > 0
	s.scrcpyMu.Lock()
	defer s.scrcpyMu.Unlock()
	result := map[string]any{"installed": installed, "version": scrcpyVersion, "running": s.scrcpyActive != nil, "last_error": s.scrcpyError}
	if active := s.scrcpyActive; active != nil {
		result["ready"], result["started_at"] = active.ready.Load(), active.started.Unix()
	}
	return result
}

func (s *Server) stopScrcpy() {
	s.scrcpyMu.Lock()
	defer s.scrcpyMu.Unlock()
	if s.scrcpyActive != nil {
		s.scrcpyActive.cancel()
	}
}

func (s *Server) shutdownScrcpy() {
	s.scrcpyMu.Lock()
	active := s.scrcpyActive
	if active != nil {
		active.cancel()
	}
	s.scrcpyMu.Unlock()
	if active != nil {
		deadline := time.NewTimer(3 * time.Second)
		defer deadline.Stop()
		select {
		case <-active.done:
		case <-deadline.C:
		}
	}
}

func (s *Server) reserveScrcpy(ctx context.Context, cancel context.CancelFunc) (*scrcpySession, error) {
	s.scrcpyMu.Lock()
	defer s.scrcpyMu.Unlock()
	if s.scrcpyActive != nil {
		return nil, errors.New("屏幕正在被使用，请先停止现有会话")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	active := &scrcpySession{cancel: cancel, started: time.Now(), done: make(chan struct{})}
	s.scrcpyActive, s.scrcpyError = active, ""
	return active, nil
}

func scrcpyArguments(socketID uint32, config EnhancedConfig) []string {
	return []string{
		"/system/bin", "com.genymobile.scrcpy.Server", scrcpyVersion,
		fmt.Sprintf("scid=%08x", socketID), "tunnel_forward=false", "audio=false", "video_codec=h264", "control=true",
		"cleanup=false", "power_on=false", "stay_awake=false", "clipboard_autosync=false", "log_level=warn",
		"send_device_meta=false", "send_dummy_byte=false", "send_stream_meta=true", "send_frame_meta=true",
		"video_codec_options=profile=1,i-frame-interval=1,repeat-previous-frame-after:long=1000000",
		fmt.Sprintf("max_size=%d", config.ScrcpyMaxSize), fmt.Sprintf("max_fps=%d", config.ScrcpyFPS), fmt.Sprintf("video_bit_rate=%d", config.ScrcpyBitRate),
	}
}

func (s *Server) handleBuiltinScrcpy(writer http.ResponseWriter, request *http.Request, config Config) {
	if request.URL.Path != "/enhanced/scrcpy/stream" {
		s.serveScrcpyAsset(writer, request)
		return
	}
	if !websocket.IsWebSocketUpgrade(request) {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"error": "屏幕流需要 WebSocket"})
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), enhancedLifetime)
	defer cancel()
	active, err := s.reserveScrcpy(ctx, cancel)
	if err != nil {
		writeJSON(writer, http.StatusConflict, map[string]any{"error": err.Error()})
		return
	}
	defer func() {
		s.scrcpyMu.Lock()
		if s.scrcpyActive == active {
			s.scrcpyActive = nil
		}
		close(active.done)
		s.scrcpyMu.Unlock()
	}()
	upgrader := websocket.Upgrader{
		HandshakeTimeout: 5 * time.Second, ReadBufferSize: 4096, WriteBufferSize: 32 << 10,
		CheckOrigin: proxyOriginAllowed,
	}
	stream, err := upgrader.Upgrade(writer, request, nil)
	if err != nil {
		return
	}
	defer stream.Close()
	input := make(chan []byte, 16)
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		defer cancel()
		stream.SetReadLimit(8192)
		_ = stream.SetReadDeadline(time.Now().Add(20 * time.Second))
		stream.SetPongHandler(func(string) error { return stream.SetReadDeadline(time.Now().Add(20 * time.Second)) })
		window, count := time.Now(), 0
		for {
			kind, message, err := stream.ReadMessage()
			if err != nil || kind != websocket.TextMessage {
				return
			}
			if time.Since(window) > time.Second {
				window, count = time.Now(), 0
			}
			count++
			if count > 180 {
				return
			}
			select {
			case input <- message:
			default:
				return
			}
		}
	}()
	defer func() { cancel(); _ = stream.Close(); <-readerDone }()
	revalidate := time.NewTicker(5 * time.Second)
	defer revalidate.Stop()
	go func() {
		for {
			select {
			case <-ctx.Done():
				_ = stream.Close()
				return
			case <-revalidate.C:
				current := s.currentConfig()
				who := request.Context().Value(contextKey{}).(caller)
				if !current.Enabled || !current.Enhanced.Scrcpy || current.Enhanced.ScrcpyMode != "builtin" || !s.originAllowed(current, who) || !s.enhancedAllowed(request, current) {
					cancel()
				} else if err := stream.WriteControl(websocket.PingMessage, nil, time.Now().Add(2*time.Second)); err != nil {
					cancel()
				}
			}
		}
	}()
	if err := s.runScrcpy(ctx, stream, input, active, config.Enhanced); err != nil && ctx.Err() == nil {
		s.scrcpyMu.Lock()
		s.scrcpyError = err.Error()
		s.scrcpyMu.Unlock()
		_ = stream.SetWriteDeadline(time.Now().Add(2 * time.Second))
		_ = stream.WriteJSON(map[string]any{"type": "error", "error": err.Error()})
	}
}

func (s *Server) runScrcpy(ctx context.Context, stream *websocket.Conn, input <-chan []byte, active *scrcpySession, config EnhancedConfig) error {
	asset := s.scrcpyAssetPath(scrcpyServerName)
	if !assetMatches(asset, scrcpyChecksum) {
		return errors.New("内置 scrcpy 文件缺失或校验失败，请重新安装完整模块")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var random [4]byte
	if _, err := rand.Read(random[:]); err != nil {
		return err
	}
	socketID := binary.BigEndian.Uint32(random[:]) & 0x7fffffff
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: fmt.Sprintf("@scrcpy_%08x", socketID), Net: "unix"})
	if err != nil {
		return fmt.Errorf("无法创建屏幕本地通道：%w", err)
	}
	defer listener.Close()
	_ = listener.SetDeadline(time.Now().Add(12 * time.Second))
	stopListener := context.AfterFunc(ctx, func() { _ = listener.Close() })
	defer stopListener()
	command := exec.CommandContext(ctx, "app_process", scrcpyArguments(socketID, config)...)
	command.Env = append(os.Environ(), "CLASSPATH="+asset)
	setupScrcpyProcess(command)
	output := &scrcpyOutput{data: limitedOutput{limit: 16 << 10}}
	command.Stdout, command.Stderr, command.WaitDelay = output, output, time.Second
	if err := command.Start(); err != nil {
		return fmt.Errorf("无法启动 Android 屏幕服务：%w", err)
	}
	finished := make(chan error, 1)
	go func() {
		finished <- command.Wait()
		_ = listener.Close()
	}()
	defer func() {
		cleanupProcess(command)
		<-finished
	}()
	video, err := listener.AcceptUnix()
	if err != nil {
		return fmt.Errorf("屏幕服务没有就绪：%s", output.String())
	}
	defer video.Close()
	if err := verifyScrcpyPeer(video, command.Process.Pid); err != nil {
		return err
	}
	control, err := listener.AcceptUnix()
	if err != nil {
		return fmt.Errorf("屏幕控制通道不可用：%s", output.String())
	}
	defer control.Close()
	if err := verifyScrcpyPeer(control, command.Process.Pid); err != nil {
		return err
	}
	_ = listener.Close()
	stopConnections := context.AfterFunc(ctx, func() { _ = video.Close(); _ = control.Close() })
	defer stopConnections()
	_ = video.SetReadDeadline(time.Now().Add(12 * time.Second))
	var codec [4]byte
	if _, err := io.ReadFull(video, codec[:]); err != nil || string(codec[:]) != "h264" {
		return fmt.Errorf("屏幕编码器未输出 H.264：%s", output.String())
	}
	active.ready.Store(true)
	_ = stream.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := stream.WriteJSON(map[string]any{"type": "ready", "codec": "h264", "fps": config.ScrcpyFPS, "version": scrcpyVersion}); err != nil {
		return err
	}
	var width, height atomic.Uint32
	group := sync.WaitGroup{}
	group.Add(2)
	go func() { defer group.Done(); defer cancel(); _, _ = io.Copy(io.Discard, control) }()
	go func() {
		defer group.Done()
		defer cancel()
		for {
			var message []byte
			select {
			case <-ctx.Done():
				return
			case message = <-input:
			}
			data, err := encodeScrcpyControl(message, width.Load(), height.Load())
			if err != nil {
				return
			}
			_ = control.SetWriteDeadline(time.Now().Add(2 * time.Second))
			if _, err := control.Write(data); err != nil {
				return
			}
		}
	}()
	defer func() { cancel(); group.Wait() }()
	for {
		_ = video.SetReadDeadline(time.Time{})
		var header [12]byte
		if _, err := io.ReadFull(video, header[:]); err != nil {
			return fmt.Errorf("屏幕流已停止：%s", output.String())
		}
		flags := binary.BigEndian.Uint64(header[:8])
		_ = stream.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if flags&(1<<63) != 0 {
			nextWidth, nextHeight := binary.BigEndian.Uint32(header[4:8]), binary.BigEndian.Uint32(header[8:])
			if nextWidth == 0 || nextHeight == 0 || nextWidth > 8192 || nextHeight > 8192 {
				return errors.New("屏幕尺寸无效")
			}
			width.Store(nextWidth)
			height.Store(nextHeight)
			if err := stream.WriteJSON(map[string]any{"type": "size", "width": nextWidth, "height": nextHeight}); err != nil {
				return err
			}
			continue
		}
		size := binary.BigEndian.Uint32(header[8:])
		if size == 0 || size > scrcpyPacketLimit {
			return errors.New("屏幕帧超过大小限制")
		}
		_ = video.SetReadDeadline(time.Now().Add(5 * time.Second))
		packet, err := stream.NextWriter(websocket.BinaryMessage)
		if err != nil {
			return err
		}
		_, headerErr := packet.Write(header[:])
		_, copyErr := io.CopyN(packet, video, int64(size))
		closeErr := packet.Close()
		if err := errors.Join(headerErr, copyErr, closeErr); err != nil {
			return err
		}
	}
}

func encodeScrcpyControl(data []byte, width, height uint32) ([]byte, error) {
	var message struct {
		Type   string `json:"type"`
		Action int    `json:"action"`
		X      uint32 `json:"x"`
		Y      uint32 `json:"y"`
		Key    uint32 `json:"key"`
		Text   string `json:"text"`
	}
	if err := decodeStrict(strings.NewReader(string(data)), &message); err != nil {
		return nil, err
	}
	switch message.Type {
	case "touch":
		if width == 0 || height == 0 || width > 8192 || height > 8192 || message.X >= width || message.Y >= height || message.Action < 0 || message.Action > 2 {
			return nil, errors.New("触控坐标或动作无效")
		}
		result := make([]byte, 32)
		result[0], result[1] = 2, byte(message.Action)
		binary.BigEndian.PutUint32(result[10:14], message.X)
		binary.BigEndian.PutUint32(result[14:18], message.Y)
		binary.BigEndian.PutUint16(result[18:20], uint16(width))
		binary.BigEndian.PutUint16(result[20:22], uint16(height))
		if message.Action != 1 {
			binary.BigEndian.PutUint16(result[22:24], 0xffff)
		}
		return result, nil
	case "key":
		switch message.Key {
		case 3, 4, 19, 20, 21, 22, 24, 25, 26, 61, 66, 67, 82, 85, 111, 122, 123, 187:
		default:
			return nil, errors.New("不支持的按键")
		}
		result := make([]byte, 28)
		binary.BigEndian.PutUint32(result[2:6], message.Key)
		result[15] = 1
		binary.BigEndian.PutUint32(result[16:20], message.Key)
		return result, nil
	case "text":
		if len(message.Text) == 0 || len(message.Text) > 4096 || !utf8.ValidString(message.Text) || strings.ContainsRune(message.Text, 0) {
			return nil, errors.New("粘贴文字须为 1–4096 字节")
		}
		result := make([]byte, 14+len(message.Text))
		result[0], result[9] = 9, 1
		binary.BigEndian.PutUint32(result[10:14], uint32(len(message.Text)))
		copy(result[14:], message.Text)
		return result, nil
	case "rotate":
		return []byte{11}, nil
	default:
		return nil, errors.New("不支持的屏幕操作")
	}
}

func (s *Server) serveScrcpyAsset(writer http.ResponseWriter, request *http.Request) {
	name := strings.TrimPrefix(request.URL.Path, "/enhanced/scrcpy/")
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; base-uri 'none'; frame-ancestors 'self'; form-action 'none'")
	if name == "jmuxer.min.js" {
		writer.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		http.ServeFile(writer, request, s.scrcpyAssetPath(name))
		return
	}
	if name == "" {
		name = "index.html"
	}
	if name != "index.html" && name != "screen.js" && name != "screen.css" {
		http.NotFound(writer, request)
		return
	}
	data, err := screenAssets.ReadFile("screen/" + name)
	if err != nil {
		http.NotFound(writer, request)
		return
	}
	switch filepath.Ext(name) {
	case ".js":
		writer.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	case ".css":
		writer.Header().Set("Content-Type", "text/css; charset=utf-8")
	default:
		writer.Header().Set("Content-Type", "text/html; charset=utf-8")
	}
	if request.Method != http.MethodHead {
		_, _ = writer.Write(data)
	}
}
