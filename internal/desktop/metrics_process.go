package desktop

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/process"
)

const (
	maxProcessSamples = 1024
	topProcessCount   = 10
	processSampleGap  = 120 * time.Millisecond
	processWorkers    = 32
)

type processSample struct {
	metric ProcessMetric
}

type processJob struct {
	index int
	value *process.Process
}

// collectProcessMetrics takes two short non-blocking process CPU samples. A
// bounded worker pool keeps status refreshes responsive even on machines with
// hundreds of processes. Memory and name failures leave null fields rather
// than turning inaccessible processes into zero-valued readings.
func collectProcessMetrics(ctx context.Context) (ProcessMetrics, error) {
	result := ProcessMetrics{TopCPU: []ProcessMetric{}, TopMemory: []ProcessMetric{}}
	processes, err := process.ProcessesWithContext(ctx)
	if err != nil {
		return result, err
	}
	truncated := len(processes) > maxProcessSamples
	if truncated {
		processes = processes[:maxProcessSamples]
	}
	if len(processes) == 0 {
		if truncated {
			return result, fmt.Errorf("process sample limited to %d entries", maxProcessSamples)
		}
		return result, nil
	}

	baselineErrors := runProcessJobs(ctx, processes, func(_ int, p *process.Process) error {
		_, err := p.PercentWithContext(ctx, 0)
		return err
	})
	if ctx.Err() != nil {
		return result, fmt.Errorf("process sample interrupted: %w", ctx.Err())
	}
	timer := time.NewTimer(processSampleGap)
	select {
	case <-timer.C:
	case <-ctx.Done():
		if !timer.Stop() {
			<-timer.C
		}
		return result, fmt.Errorf("process sample interrupted: %w", ctx.Err())
	}

	samples := make([]processSample, len(processes))
	for i, p := range processes {
		samples[i].metric.PID = p.Pid
	}
	readErrors := runProcessJobs(ctx, processes, func(index int, p *process.Process) error {
		metric := &samples[index].metric
		var firstErr error
		if value, err := p.PercentWithContext(ctx, 0); err == nil {
			metric.CPUPercent = &value
		} else {
			firstErr = err
		}
		if value, err := p.NameWithContext(ctx); err == nil {
			metric.Name = &value
		} else if firstErr == nil {
			firstErr = err
		}
		if value, err := p.MemoryInfoWithContext(ctx); err == nil && value != nil {
			bytes := value.RSS
			metric.MemoryBytes = &bytes
		} else if firstErr == nil {
			firstErr = err
		}
		if value, err := p.StatusWithContext(ctx); err == nil && len(value) > 0 {
			status := value[0]
			metric.Status = &status
		}
		return firstErr
	})

	cpu := make([]ProcessMetric, 0, len(samples))
	memory := make([]ProcessMetric, 0, len(samples))
	for _, sample := range samples {
		if sample.metric.CPUPercent != nil {
			cpu = append(cpu, sample.metric)
		}
		if sample.metric.MemoryBytes != nil {
			memory = append(memory, sample.metric)
		}
	}
	sort.SliceStable(cpu, func(i, j int) bool {
		if *cpu[i].CPUPercent == *cpu[j].CPUPercent {
			return cpu[i].PID < cpu[j].PID
		}
		return *cpu[i].CPUPercent > *cpu[j].CPUPercent
	})
	sort.SliceStable(memory, func(i, j int) bool {
		if *memory[i].MemoryBytes == *memory[j].MemoryBytes {
			return memory[i].PID < memory[j].PID
		}
		return *memory[i].MemoryBytes > *memory[j].MemoryBytes
	})
	if len(cpu) > topProcessCount {
		cpu = cpu[:topProcessCount]
	}
	if len(memory) > topProcessCount {
		memory = memory[:topProcessCount]
	}
	result.TopCPU = cpu
	result.TopMemory = memory
	if truncated {
		return result, fmt.Errorf("process sample limited to %d entries", maxProcessSamples)
	}
	if baselineErrors+readErrors > 0 {
		return result, fmt.Errorf("some process fields were unavailable; inaccessible values are null")
	}
	return result, nil
}

func runProcessJobs(ctx context.Context, processes []*process.Process, fn func(int, *process.Process) error) int {
	workerCount := processWorkers
	if len(processes) < workerCount {
		workerCount = len(processes)
	}
	jobs := make(chan processJob)
	var workers sync.WaitGroup
	var mu sync.Mutex
	errors := 0
	for i := 0; i < workerCount; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case job, ok := <-jobs:
					if !ok {
						return
					}
					if err := fn(job.index, job.value); err != nil {
						mu.Lock()
						errors++
						mu.Unlock()
					}
				}
			}
		}()
	}
	for index, value := range processes {
		select {
		case <-ctx.Done():
			break
		case jobs <- processJob{index: index, value: value}:
		}
		if ctx.Err() != nil {
			break
		}
	}
	close(jobs)
	workers.Wait()
	return errors
}
