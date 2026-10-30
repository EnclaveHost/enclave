package desktop

import (
	"math"
	"testing"
)

func TestCPUAllocationSeparatesDefaultAndPurchasedQuota(t *testing.T) {
	for _, c := range []struct{ policy, minimum, requested, cpu, vcpus int }{
		{400, 4, 0, 400, 4}, {800, 8, 0, 800, 8},
		{400, 4, 600, 600, 6}, {400, 4, 401, 401, 5},
		{800, 8, 400, 400, 8}, {400, 4, 1600, 1600, 16},
	} {
		cpu, vcpus, err := CPUAllocation(c.policy, c.minimum, c.requested)
		if err != nil || cpu != c.cpu || vcpus != c.vcpus {
			t.Fatalf("%+v: got %d/%d, %v", c, cpu, vcpus, err)
		}
		limits, err := Limits(cpu, 8192, vcpus)
		if err != nil || len(limits) == 0 {
			t.Fatalf("allocation cannot configure a desktop cgroup: %v", err)
		}
		if CheckCapacity(8192, vcpus, vcpus, 9*1024*1024) != nil {
			t.Fatal("exact processor capacity refused")
		}
		if CheckCapacity(8192, vcpus-1, vcpus, 9*1024*1024) == nil {
			t.Fatal("CPU allocation exceeded guest processor capacity")
		}
	}
}

func TestCPUAllocationRefusesMalformedPolicyAndUnsafeRequests(t *testing.T) {
	for _, request := range []int{math.MinInt, -1, 1, 399, 1601, math.MaxInt} {
		if _, _, err := CPUAllocation(400, 4, request); err == nil {
			t.Fatalf("unsafe request %d accepted", request)
		}
	}
	for _, policy := range [][2]int{{0, 4}, {399, 4}, {1601, 16}, {500, 4}, {400, 3}, {400, 17}, {math.MaxInt, math.MaxInt}} {
		if _, _, err := CPUAllocation(policy[0], policy[1], 400); err == nil {
			t.Fatalf("unsafe catalog policy %v accepted", policy)
		}
	}
}
