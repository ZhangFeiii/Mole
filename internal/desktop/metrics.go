package desktop

// The collection strategy and gopsutil dependencies are adapted from the MIT
// licensed Windows cmd/status/main.go. No TUI or mutating commands are linked.
import (
	"context"
	"fmt"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/mem"
	"github.com/shirou/gopsutil/v3/net"
)

type Volume struct {
	Path       string `json:"path"`
	Filesystem string `json:"filesystem"`
	Total      uint64 `json:"total"`
	Used       uint64 `json:"used"`
	Free       uint64 `json:"free"`
}

type Metrics struct {
	CollectedAt     int64    `json:"collectedAt"`
	Platform        string   `json:"platform"`
	OS              string   `json:"os"`
	Hostname        string   `json:"hostname"`
	Uptime          uint64   `json:"uptime"`
	CPUModel        string   `json:"cpuModel"`
	Cores           int      `json:"cores"`
	CPUPercent      *float64 `json:"cpuPercent"`
	MemoryTotal     uint64   `json:"memoryTotal"`
	MemoryUsed      uint64   `json:"memoryUsed"`
	MemoryPercent   *float64 `json:"memoryPercent"`
	NetworkSent     *uint64  `json:"networkSent"`
	NetworkReceived *uint64  `json:"networkReceived"`
	Volumes         []Volume `json:"volumes"`
	Warnings        []string `json:"warnings"`
}

// Collect takes a fresh, short CPU sample. Missing metrics remain null, never
// fabricated zeroes. Network counters are cumulative; the UI computes deltas.
func Collect(ctx context.Context) Metrics {
	m := Metrics{Platform: runtime.GOOS, Cores: runtime.NumCPU(), Volumes: []Volume{}, Warnings: []string{}}
	var mu sync.Mutex
	var wg sync.WaitGroup
	warn := func(area string, err error) { m.Warnings = append(m.Warnings, fmt.Sprintf("%s: %v", area, err)) }
	// Some upstream platform parsers panic on restricted or unexpected OS output.
	// Keep unrelated readings available and explicitly report the failed metric.
	guard := func(area string) {
		if recovered := recover(); recovered != nil {
			mu.Lock()
			defer mu.Unlock()
			warn(area, fmt.Errorf("platform collector unavailable: %v", recovered))
		}
	}
	wg.Add(4)
	go func() {
		defer wg.Done()
		defer guard("host")
		h, err := host.InfoWithContext(ctx)
		mu.Lock()
		defer mu.Unlock()
		if err != nil {
			warn("host", err)
			return
		}
		m.Hostname, m.OS, m.Uptime = h.Hostname, strings.TrimSpace(h.Platform+" "+h.PlatformVersion), h.Uptime
	}()
	go func() {
		defer wg.Done()
		defer guard("cpu")
		info, infoErr := cpu.InfoWithContext(ctx)
		p, err := cpu.PercentWithContext(ctx, 250*time.Millisecond, false)
		mu.Lock()
		defer mu.Unlock()
		if infoErr == nil && len(info) > 0 {
			m.CPUModel = info[0].ModelName
		}
		if err != nil {
			warn("cpu", err)
		} else if len(p) > 0 {
			m.CPUPercent = &p[0]
		}
	}()
	go func() {
		defer wg.Done()
		defer guard("memory")
		v, err := mem.VirtualMemoryWithContext(ctx)
		mu.Lock()
		defer mu.Unlock()
		if err != nil {
			warn("memory", err)
			return
		}
		m.MemoryTotal, m.MemoryUsed, m.MemoryPercent = v.Total, v.Used, &v.UsedPercent
	}()
	go func() {
		defer wg.Done()
		defer guard("network")
		counters, err := net.IOCountersWithContext(ctx, true)
		mu.Lock()
		defer mu.Unlock()
		if err != nil {
			warn("network", err)
			return
		}
		var sent, received uint64
		for _, n := range counters {
			if n.Name == "lo" || n.Name == "lo0" || strings.Contains(strings.ToLower(n.Name), "loopback") {
				continue
			}
			sent += n.BytesSent
			received += n.BytesRecv
		}
		m.NetworkSent, m.NetworkReceived = &sent, &received
	}()
	wg.Wait()
	partitions, err := disk.PartitionsWithContext(ctx, false)
	if err != nil {
		warn("volumes", err)
	}
	seen := map[string]bool{}
	for _, p := range partitions {
		if ctx.Err() != nil {
			warn("volumes", ctx.Err())
			break
		}
		if seen[p.Mountpoint] || !localVolume(p.Mountpoint) {
			continue
		}
		if runtime.GOOS != "windows" && p.Mountpoint != "/" && !strings.HasPrefix(p.Mountpoint, "/Volumes/") && !strings.HasPrefix(p.Mountpoint, "/media/") {
			continue
		}
		seen[p.Mountpoint] = true
		u, e := disk.UsageWithContext(ctx, p.Mountpoint)
		if e != nil {
			warn("volume "+p.Mountpoint, e)
			continue
		}
		if u.Total == 0 {
			continue
		}
		m.Volumes = append(m.Volumes, Volume{Path: p.Mountpoint, Filesystem: p.Fstype, Total: u.Total, Used: u.Used, Free: u.Free})
	}
	sort.Slice(m.Volumes, func(i, j int) bool { return m.Volumes[i].Path < m.Volumes[j].Path })
	m.CollectedAt = time.Now().UnixMilli()
	return m
}
