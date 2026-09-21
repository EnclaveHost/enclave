# vkfield -- the Vulkan field GEMM harness. No Vulkan SDK: only the headers (VULKAN_INCLUDE) and the
# runtime loader that ships with every driver. Shaders are built by glslc here and shipped as SPIR-V.
VULKAN_INCLUDE ?= $(HOME)/.cache/Vulkan-Headers/include
FIELD_DIR := ../../wasm/ggml-shielded
CXX := clang++
SHADERS := shaders/pack24.spv $(foreach mr,1 2 3 4 5 6 7 8,$(foreach g,1 2 4 8,shaders/field_gemm_mr$(mr)_g$(g).spv))

all: vkfield $(SHADERS)

shaders/field_gemm_mr%.spv: shaders/field_gemm.comp
	glslc --target-env=vulkan1.3 -O -DMR=$(word 1,$(subst _g, ,$*)) -DG=$(word 2,$(subst _g, ,$*)) -o $@ $<
	spirv-val --target-env vulkan1.3 $@
shaders/pack24.spv: shaders/pack24.comp
	glslc --target-env=vulkan1.3 -O -o $@ $< && spirv-val --target-env vulkan1.3 $@

shielded-field.o: $(FIELD_DIR)/shielded-field.c $(FIELD_DIR)/shielded-field.h
	$(CC) -O2 -ffp-contract=off -fPIC -I$(FIELD_DIR) -c $< -o $@
vkfield: vkfield.cpp shielded-field.o
	$(CXX) -O2 -std=c++17 -I$(VULKAN_INCLUDE) -I$(FIELD_DIR) vkfield.cpp shielded-field.o -o $@ -ldl

clean:
	rm -f vkfield shielded-field.o
.PHONY: all clean

# ---- the worker itself on Vulkan: ../worker-cuda/worker.cu compiled as C++ against vkdev.h ----
shielded-worker: ../worker-cuda/worker.cu ../worker-cuda/device.h vkdev.h vkdev.cpp shielded-field.o $(SHADERS)
	$(CXX) -O3 -std=c++17 -x c++ -DSH_VULKAN -I. -I../worker-cuda -I$(FIELD_DIR) -I$(VULKAN_INCLUDE) -ffp-contract=off \
	  -c ../worker-cuda/worker.cu -o worker.o
	$(CXX) -O2 -std=c++17 -I. -I$(VULKAN_INCLUDE) -c vkdev.cpp -o vkdev.o
	$(CXX) -o $@ worker.o vkdev.o shielded-field.o -ldl -lrt -lpthread
